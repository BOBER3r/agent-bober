/**
 * Unit + integration tests for src/incident/resolution-verify.ts (Sprint 22).
 *
 * Uses an injected MetricQueryClient to avoid spawning real observability
 * MCPs in tests. Evidence files write to a fresh mkdtemp directory per test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyResolution,
  sampleMeetsThreshold,
  type ResolutionCriteria,
  type MetricQueryClient,
  type MetricSample,
} from "../../src/incident/resolution-verify.js";
import { createIncident, setIncidentStatus } from "../../src/incident/timeline.js";
import type { ObservabilityProvider } from "../../src/config/schema.js";

// ── Temp directory fixture ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-resverify-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeProvider(name = "datadog"): ObservabilityProvider {
  return { name, kind: "metrics", mcpCommand: "node", enabled: true };
}

function fakeClient(samples: MetricSample[]): MetricQueryClient {
  return { async queryMetric() { return samples; } };
}

const baseCriteria: ResolutionCriteria = {
  metricName: "api.checkout.error_rate",
  threshold: 0.01,
  comparison: "lt",
  windowMinutes: 10,
  provider: "datadog",
  baselineComparison: "absolute",
};

// ── sampleMeetsThreshold — boundary semantics ──────────────────────────────────

describe("sampleMeetsThreshold — boundary semantics", () => {
  it("'lt' is strict (value === threshold FAILS)", () => {
    expect(sampleMeetsThreshold(0.01, 0.01, "lt")).toBe(false);
    expect(sampleMeetsThreshold(0.009, 0.01, "lt")).toBe(true);
  });

  it("'lte' is inclusive (value === threshold PASSES)", () => {
    expect(sampleMeetsThreshold(0.01, 0.01, "lte")).toBe(true);
    expect(sampleMeetsThreshold(0.011, 0.01, "lte")).toBe(false);
  });

  it("'gt' is strict", () => {
    expect(sampleMeetsThreshold(0.5, 0.5, "gt")).toBe(false);
    expect(sampleMeetsThreshold(0.51, 0.5, "gt")).toBe(true);
  });

  it("'gte' is inclusive", () => {
    expect(sampleMeetsThreshold(0.5, 0.5, "gte")).toBe(true);
    expect(sampleMeetsThreshold(0.49, 0.5, "gte")).toBe(false);
  });
});

// ── verifyResolution — happy path ──────────────────────────────────────────────

describe("verifyResolution — happy path", () => {
  it("10 samples all under threshold → verified=true", async () => {
    const incidentId = await createIncident("checkout errors", tmpDir);
    const samples = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(2026, 4, 24, 14, 20 + i).toISOString(),
      value: 0.0008,
    }));
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(true);
    expect(r.reason).toBe("OK");
    expect(r.evidencePath).toBeTruthy();
  });
});

// ── verifyResolution — outlier ─────────────────────────────────────────────────

describe("verifyResolution — outlier", () => {
  it("9 under threshold + 1 outlier → verified=false, reason='OUTLIER'", async () => {
    const incidentId = await createIncident("spike", tmpDir);
    const samples: MetricSample[] = Array.from({ length: 9 }, (_, i) => ({
      timestamp: new Date(2026, 4, 24, 14, 20 + i).toISOString(),
      value: 0.0008,
    }));
    samples.push({ timestamp: new Date(2026, 4, 24, 14, 29).toISOString(), value: 0.05 });
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("OUTLIER");
    expect(r.observedValue).toBe(0.05);
  });
});

// ── verifyResolution — boundary at exactly threshold ──────────────────────────

describe("verifyResolution — boundary at exactly threshold", () => {
  it("comparison='lt' with sample === threshold → verified=false", async () => {
    const incidentId = await createIncident("boundary lt", tmpDir);
    const samples: MetricSample[] = [
      { timestamp: "2026-05-24T14:20:00Z", value: 0.005 },
      { timestamp: "2026-05-24T14:21:00Z", value: 0.01 }, // exactly threshold
    ];
    const r = await verifyResolution(incidentId, { ...baseCriteria, comparison: "lt" }, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(false);
  });

  it("comparison='lte' with sample === threshold → verified=true", async () => {
    const incidentId = await createIncident("boundary lte", tmpDir);
    const samples: MetricSample[] = [
      { timestamp: "2026-05-24T14:20:00Z", value: 0.005 },
      { timestamp: "2026-05-24T14:21:00Z", value: 0.01 }, // exactly threshold
    ];
    const r = await verifyResolution(incidentId, { ...baseCriteria, comparison: "lte" }, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(true);
  });
});

// ── verifyResolution — NO_PROVIDER ─────────────────────────────────────────────

describe("verifyResolution — NO_PROVIDER", () => {
  it("empty providers → verified=false, reason='NO_PROVIDER', hint mentions bober.config.json AND override token", async () => {
    const incidentId = await createIncident("no provider", tmpDir);
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [], // none configured
    });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("NO_PROVIDER");
    expect(r.hint).toMatch(/bober\.config\.json/);
    expect(r.hint).toMatch(/observability\.providers/);
    expect(r.hint).toMatch(/SKIP_METRIC_VERIFY/);
  });

  it("provider with matching name but enabled=false → verified=false, reason='NO_PROVIDER'", async () => {
    const incidentId = await createIncident("disabled provider", tmpDir);
    const disabledProvider: ObservabilityProvider = {
      name: "datadog",
      kind: "metrics",
      mcpCommand: "node",
      enabled: false,
    };
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [disabledProvider],
    });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("NO_PROVIDER");
  });
});

// ── verifyResolution — evidence file ──────────────────────────────────────────

describe("verifyResolution — evidence file", () => {
  it("writes JSON file to .bober/incidents/<id>/resolution-evidence/ even when verified=false", async () => {
    const incidentId = await createIncident("evidence", tmpDir);
    const samples: MetricSample[] = [{ timestamp: "2026-05-24T14:20:00Z", value: 99 }];
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(false);
    expect(r.evidencePath).toBeTruthy();
    const raw = await readFile(r.evidencePath!, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.incidentId).toBe(incidentId);
    expect(parsed.allSamplesPassed).toBe(false);
    expect(parsed.samples).toEqual(samples);
    expect(parsed.criteria.metricName).toBe("api.checkout.error_rate");
  });

  it("writes JSON file with allSamplesPassed=true when verified=true", async () => {
    const incidentId = await createIncident("evidence pass", tmpDir);
    const samples: MetricSample[] = [
      { timestamp: "2026-05-24T14:20:00Z", value: 0.001 },
      { timestamp: "2026-05-24T14:21:00Z", value: 0.002 },
    ];
    const r = await verifyResolution(incidentId, baseCriteria, {
      projectRoot: tmpDir,
      providers: [fakeProvider()],
      client: fakeClient(samples),
    });
    expect(r.verified).toBe(true);
    const raw = await readFile(r.evidencePath!, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.allSamplesPassed).toBe(true);
    expect(parsed.samples).toHaveLength(2);
  });
});

// ── setIncidentStatus 'resolved' gate (s22-c3, s22-c4) ────────────────────────

describe("setIncidentStatus 'resolved' gate (s22-c3, s22-c4)", () => {
  it("without verifyResult and without overrideToken → THROWS", async () => {
    const incidentId = await createIncident("gate1", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved"),
    ).rejects.toThrow(/verifyResult|overrideToken|SKIP_METRIC_VERIFY/);
  });

  it("with verifyResult.verified=false → THROWS", async () => {
    const incidentId = await createIncident("gate2", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
        verifyResult: { verified: false, reason: "OUTLIER" },
      }),
    ).rejects.toThrow(/verifyResult|verified/);
  });

  it("with verifyResult.verified=true → succeeds + writes resolutionEvidence", async () => {
    const incidentId = await createIncident("gate3", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
      verifyResult: {
        verified: true,
        observedValue: 0.0008,
        sampledAt: "2026-05-24T14:30:00Z",
        evidencePath: ".bober/incidents/x/resolution-evidence/y.json",
        reason: "OK",
      },
      autoPostmortem: false, // Sprint 23: suppress fire-and-forget to avoid test-cleanup race
    });
    const raw = await readFile(join(tmpDir, ".bober", "incidents", incidentId, "incident.json"), "utf-8");
    const meta = JSON.parse(raw);
    expect(meta.status).toBe("resolved");
    expect(meta.resolutionEvidence.verified).toBe(true);
    expect(meta.resolutionEvidence.observedValue).toBe(0.0008);
  });

  it("override with reason → succeeds + logs 'incident_resolved_override' to timeline.jsonl", async () => {
    const incidentId = await createIncident("override ok", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
      overrideToken: "SKIP_METRIC_VERIFY: datadog ingestion paused — confirmed via support ticket #1234",
      autoPostmortem: false, // Sprint 23: suppress fire-and-forget to avoid test-cleanup race
    });
    const tlRaw = await readFile(
      join(tmpDir, ".bober", "incidents", incidentId, "timeline.jsonl"),
      "utf-8",
    );
    const lines = tlRaw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const overrideEvt = lines.find((l) => l.eventKind === "incident_resolved_override");
    expect(overrideEvt).toBeTruthy();
    expect(overrideEvt.summary).toMatch(/datadog ingestion paused/);
  });

  it("override with EMPTY reason ('SKIP_METRIC_VERIFY:') → THROWS", async () => {
    const incidentId = await createIncident("override empty", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
        overrideToken: "SKIP_METRIC_VERIFY:",
      }),
    ).rejects.toThrow();
  });

  it("override with whitespace-only reason ('SKIP_METRIC_VERIFY:   ') → THROWS", async () => {
    const incidentId = await createIncident("override ws", tmpDir);
    await expect(
      setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
        overrideToken: "SKIP_METRIC_VERIFY:    ",
      }),
    ).rejects.toThrow();
  });

  it("override stores reason in resolutionEvidence.override.reason", async () => {
    const incidentId = await createIncident("override evidence", tmpDir);
    const reason = "metrics pipeline degraded — ops confirmed recovery via dashboard";
    await setIncidentStatus(tmpDir, incidentId, "resolved", undefined, {
      overrideToken: `SKIP_METRIC_VERIFY: ${reason}`,
      autoPostmortem: false, // Sprint 23: suppress fire-and-forget to avoid test-cleanup race
    });
    const raw = await readFile(
      join(tmpDir, ".bober", "incidents", incidentId, "incident.json"),
      "utf-8",
    );
    const meta = JSON.parse(raw);
    expect(meta.resolutionEvidence.verified).toBe(false);
    expect(meta.resolutionEvidence.override.reason).toBe(reason);
  });
});

// ── verifyResolution — baselineComparison deferred ────────────────────────────

describe("verifyResolution — baselineComparison deferred", () => {
  it("'percent-of-baseline' returns NOT_IMPLEMENTED", async () => {
    const incidentId = await createIncident("baseline deferred", tmpDir);
    const r = await verifyResolution(
      incidentId,
      { ...baseCriteria, baselineComparison: "percent-of-baseline" },
      { projectRoot: tmpDir, providers: [fakeProvider()] },
    );
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("NOT_IMPLEMENTED");
  });
});

// ── Non-'resolved' transitions remain unaffected ──────────────────────────────

describe("setIncidentStatus — non-resolved transitions unaffected", () => {
  it("'remediating' transition works without opts", async () => {
    const incidentId = await createIncident("non-resolved", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "remediating");
    const raw = await readFile(
      join(tmpDir, ".bober", "incidents", incidentId, "incident.json"),
      "utf-8",
    );
    const meta = JSON.parse(raw);
    expect(meta.status).toBe("remediating");
  });

  it("'monitoring' transition works without opts", async () => {
    const incidentId = await createIncident("monitoring", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "monitoring");
    const raw = await readFile(
      join(tmpDir, ".bober", "incidents", incidentId, "incident.json"),
      "utf-8",
    );
    const meta = JSON.parse(raw);
    expect(meta.status).toBe("monitoring");
  });

  it("'aborted' transition works without opts", async () => {
    const incidentId = await createIncident("aborted", tmpDir);
    await setIncidentStatus(tmpDir, incidentId, "aborted");
    const raw = await readFile(
      join(tmpDir, ".bober", "incidents", incidentId, "incident.json"),
      "utf-8",
    );
    const meta = JSON.parse(raw);
    expect(meta.status).toBe("aborted");
  });
});
