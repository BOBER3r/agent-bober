/**
 * Unit tests for bober_incident_* tools (Sprint 6).
 *
 * Tests each of the four incident tools: start, status, list, abort.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerIncidentTools } from "./incident.js";
import { getTool } from "./registry.js";
import { createIncident } from "../../incident/timeline.js";

let tmpDir: string;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = await mkdtemp(join(tmpdir(), "bober-incident-tool-test-"));
  registerIncidentTools();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── bober_incident_start ────────────────────────────────────────────────────────

describe("bober_incident_start", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_incident_start")).toBeDefined();
  });

  it("creates an incident and returns { incidentId, status, createdAt }", async () => {
    const tool = getTool("bober_incident_start")!;
    const result = JSON.parse(
      await tool.handler({ symptom: "error rate spiking", projectPath: tmpDir }),
    ) as { incidentId: string; status: string; createdAt: string };
    expect(result).toMatchObject({ status: "investigating" });
    expect(result.incidentId).toMatch(/^inc-/);
    expect(result.createdAt).toBeTruthy();
  });

  it("creates an incident with severity when provided", async () => {
    const tool = getTool("bober_incident_start")!;
    const result = JSON.parse(
      await tool.handler({
        symptom: "database latency high",
        severity: "S2",
        projectPath: tmpDir,
      }),
    ) as { incidentId: string; status: string; severity?: string };
    expect(result.status).toBe("investigating");
    expect(result.severity).toBe("S2");
  });

  it("returns soft error for empty symptom", async () => {
    const tool = getTool("bober_incident_start")!;
    const result = JSON.parse(
      await tool.handler({ symptom: "", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("symptom is required");
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_incident_start")!;
    const result = JSON.parse(
      await tool.handler({ symptom: "test", projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns soft error for invalid severity", async () => {
    const tool = getTool("bober_incident_start")!;
    const result = JSON.parse(
      await tool.handler({ symptom: "test", severity: "CRITICAL", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("Invalid severity");
  });
});

// ── bober_incident_status ────────────────────────────────────────────────────────

describe("bober_incident_status", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_incident_status")).toBeDefined();
  });

  it("reads incident metadata for an existing incident", async () => {
    // Create an incident using the underlying helper
    const incidentId = await createIncident("service unavailable", tmpDir);

    const tool = getTool("bober_incident_status")!;
    const result = JSON.parse(
      await tool.handler({ incidentId, projectPath: tmpDir }),
    ) as { incidentId: string; symptom: string; status: string; createdAt: string };
    expect(result).toMatchObject({
      incidentId,
      symptom: "service unavailable",
      status: "investigating",
    });
    expect(result.createdAt).toBeTruthy();
  });

  it("returns soft error for missing incident", async () => {
    const tool = getTool("bober_incident_status")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "inc-nonexistent", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("inc-nonexistent");
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_incident_status")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "any", projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns soft error for empty incidentId", async () => {
    const tool = getTool("bober_incident_status")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("incidentId is required");
  });
});

// ── bober_incident_list ────────────────────────────────────────────────────────

describe("bober_incident_list", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_incident_list")).toBeDefined();
  });

  it("returns empty array when no incidents exist", async () => {
    const tool = getTool("bober_incident_list")!;
    const result = JSON.parse(
      await tool.handler({ projectPath: tmpDir }),
    ) as unknown[];
    expect(result).toEqual([]);
  });

  it("lists incidents sorted descending by createdAt", async () => {
    // Create two incidents using the underlying helper
    await createIncident("first issue", tmpDir);
    await createIncident("second issue", tmpDir);

    const tool = getTool("bober_incident_list")!;
    const result = JSON.parse(
      await tool.handler({ projectPath: tmpDir }),
    ) as Array<{ incidentId: string; symptom: string; status: string }>;

    expect(result.length).toBe(2);
    // Result is sorted descending by createdAt — second created should be first
    for (const item of result) {
      expect(item).toMatchObject({ status: "investigating" });
      expect(item.incidentId).toMatch(/^inc-/);
    }
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_incident_list")!;
    const result = JSON.parse(
      await tool.handler({ projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });
});

// ── bober_incident_abort ────────────────────────────────────────────────────────

describe("bober_incident_abort", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_incident_abort")).toBeDefined();
  });

  it("aborts an incident and returns { incidentId, status, abortReportPath }", async () => {
    const incidentId = await createIncident("memory leak", tmpDir);

    const tool = getTool("bober_incident_abort")!;
    const result = JSON.parse(
      await tool.handler({
        incidentId,
        reason: "False alarm — resolved manually",
        projectPath: tmpDir,
      }),
    ) as { incidentId: string; status: string; abortReportPath: string };

    expect(result).toMatchObject({ incidentId, status: "aborted" });
    expect(result.abortReportPath).toContain("abort-report.md");
  });

  it("returns soft error for empty incidentId", async () => {
    const tool = getTool("bober_incident_abort")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "", reason: "test", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("incidentId is required");
  });

  it("returns soft error for empty reason", async () => {
    const tool = getTool("bober_incident_abort")!;
    const incidentId = await createIncident("test incident", tmpDir);
    const result = JSON.parse(
      await tool.handler({ incidentId, reason: "", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("reason is required");
  });

  it("returns soft error for relative projectPath", async () => {
    const tool = getTool("bober_incident_abort")!;
    const result = JSON.parse(
      await tool.handler({ incidentId: "any", reason: "test", projectPath: "./relative" }),
    ) as { error: string };
    expect(result.error).toBe("projectPath must be absolute");
  });

  it("returns soft error when trying to abort an already-aborted incident", async () => {
    const incidentId = await createIncident("double abort test", tmpDir);
    const tool = getTool("bober_incident_abort")!;

    // First abort
    await tool.handler({ incidentId, reason: "First abort", projectPath: tmpDir });

    // Second abort
    const result = JSON.parse(
      await tool.handler({ incidentId, reason: "Second abort", projectPath: tmpDir }),
    ) as { error: string };
    expect(result.error).toContain("already aborted");
  });
});
