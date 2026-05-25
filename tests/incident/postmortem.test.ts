/**
 * Unit tests for src/incident/postmortem.ts (Sprint 23).
 *
 * Test location: tests/incident/postmortem.test.ts — non-colocated test tree
 * following the project's convention (tests/incident/*.test.ts).
 *
 * Each test uses a fresh mkdtemp directory as projectRoot so NO files are
 * written to the repo's .bober/incidents/ directory.
 *
 * 7 tests:
 *  1. Happy path: produces postmortem.md with all required template sections.
 *  2. Citation count > 5 in the generated postmortem.
 *  3. 5-Whys deep chain: fixture with diagnosis + evidence + pre-incident changelog.
 *  4. 5-Whys shallow: no diagnoses → shallow-warning emitted.
 *  5. Auto-trigger on resolved (autoPostmortem=true): status transition returns
 *     immediately; postmortem appears AFTER awaiting onPostmortemPromise.
 *  6. autoPostmortem=false → no automatic generation triggered.
 *  7. Redaction: fixture with fake API key → output does NOT contain the key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generatePostmortem } from "../../src/incident/postmortem.js";
import {
  createIncident,
  appendTimeline,
  appendObservation,
  appendAction,
  appendChange,
  appendRunbookExecution,
  setIncidentStatus,
} from "../../src/incident/timeline.js";
import type {
  ObservationEntry,
  ActionEntry,
  ChangeEntry,
  RunbookExecutionEntry,
} from "../../src/incident/types.js";

// ── Temp directory fixture ─────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-postmortem-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helper: build a fully-seeded fixture incident ─────────────────────────────

/**
 * Creates a resolved incident with a full artifact set for happy-path tests.
 * autoPostmortem is set to false so the fixture creation does NOT trigger
 * background synthesis — tests call generatePostmortem explicitly.
 */
async function makeFixtureIncident(rootDir: string): Promise<string> {
  // Use a fixed-ish date in the symptom for deterministic IDs.
  const incidentId = await createIncident("500 errors on api-checkout", rootDir);
  const dir = join(rootDir, ".bober", "incidents", incidentId);

  // Seed timeline with 5 events spanning ~38 minutes.
  await appendTimeline(rootDir, incidentId, {
    timestamp: "2026-05-24T14:00:00Z",
    eventKind: "alert_fired",
    source: "observability",
    summary: "Datadog alert: api.checkout.error_rate > 5%",
  });
  await appendTimeline(rootDir, incidentId, {
    timestamp: "2026-05-24T14:05:00Z",
    eventKind: "oncall_paged",
    source: "system",
    summary: "On-call engineer paged via PagerDuty",
  });
  await appendTimeline(rootDir, incidentId, {
    timestamp: "2026-05-24T14:12:00Z",
    eventKind: "hypothesis_formed",
    source: "diagnoser",
    summary: "Leading hypothesis: db connection pool exhaustion",
  });
  await appendTimeline(rootDir, incidentId, {
    timestamp: "2026-05-24T14:25:00Z",
    eventKind: "remediation_started",
    source: "deployer",
    summary: "Scaling db replicas 3 to 6",
  });
  await appendTimeline(rootDir, incidentId, {
    timestamp: "2026-05-24T14:38:00Z",
    eventKind: "resolution_verified",
    source: "system",
    summary: "Error rate < 0.1% for 10 min sustained",
  });

  // Seed observations (verified=true for Impact section).
  const obs1: ObservationEntry = {
    timestamp: "2026-05-24T14:06:00Z",
    phase: 1,
    observation: "Confirmed error rate 11.8% at 14:06 via fresh metric query",
    source: "obs__datadog__query_metric",
    verified: true,
  };
  await appendObservation(rootDir, incidentId, obs1);

  const obs2: ObservationEntry = {
    timestamp: "2026-05-24T14:08:00Z",
    phase: 2,
    observation: "Connection pool saturation: 98% sustained from 14:01",
    source: "obs__datadog__query_metric",
    verified: true,
  };
  await appendObservation(rootDir, incidentId, obs2);

  // Seed changelog (executedAt BEFORE incident createdAt by <30 min — Why-4 candidate).
  // We need executedAt < incident.createdAt to qualify as pre-incident change.
  // createIncident sets createdAt = new Date().toISOString(), so we seed a change
  // with executedAt = createdAt - 5 minutes.
  const incidentMeta = JSON.parse(
    await readFile(join(dir, "incident.json"), "utf-8"),
  ) as { createdAt: string };
  const preIncidentTime = new Date(
    Date.parse(incidentMeta.createdAt) - 5 * 60 * 1000,
  ).toISOString();

  const change: ChangeEntry = {
    id: "chg-1",
    type: "k8s_scale",
    executedAt: preIncidentTime,
    description: "scale db replicas 3 to 6 to handle increased load",
    inverse: {
      description: "scale db replicas 6 to 3",
      command: "kubectl scale --replicas=3 deployment/db-pool",
    },
    status: "executed",
  };
  await appendChange(rootDir, incidentId, change);

  // Seed runbook execution (1 success, 0 failures).
  const rbEntry: RunbookExecutionEntry = {
    timestamp: "2026-05-24T14:20:00Z",
    runbookName: "scale-db-tier",
    stepNumber: 1,
    status: "success",
    preconditionResult: "pass",
    postconditionResult: "pass",
  };
  await appendRunbookExecution(rootDir, incidentId, rbEntry);

  // Seed actions (one risky action WITH a matching precondition pass timestamp — no violation).
  const action: ActionEntry = {
    timestamp: "2026-05-24T14:22:00Z",
    action: "kubectl scale deployment db-pool --replicas=6",
    blastRadius: "risky",
    requiresApproval: true,
  };
  await appendAction(rootDir, incidentId, action);

  // Seed diagnoses/.
  const diagnosisId = `diagnosis-${incidentId}-2026-05-24T14:12:00Z`;
  await mkdir(join(dir, "diagnoses"), { recursive: true });
  await writeFile(
    join(dir, "diagnoses", `${diagnosisId}.json`),
    JSON.stringify(
      {
        diagnosisId,
        incidentId,
        timestamp: "2026-05-24T14:12:00Z",
        summary: "Leading hypothesis: db connection pool exhaustion under new checkout flow",
        hypotheses: [
          {
            id: "h1",
            statement:
              "Database connection pool is exhausted, causing checkout queries to timeout",
            confidence: "high",
            supportingEvidence: [
              {
                source: "infra-metrics",
                path: "obs__datadog__query_metric#pool_saturation",
                snippet: "Connection pool saturation 98% sustained from 14:01",
              },
              {
                source: "app-logs",
                path: "obs__loki__query_logs",
                snippet:
                  "Timeout: connection acquisition failed after 30s (200+ occurrences)",
              },
            ],
            contradictingEvidence: [],
          },
        ],
        nextActions: [],
      },
      null,
      2,
    ),
  );

  // Seed hypotheses.md.
  await writeFile(
    join(dir, "hypotheses.md"),
    "Disproved: Network partition (no evidence of inter-region latency)\n" +
      "Open: Why did the connection pool grow? Migration 042?\n",
    { encoding: "utf-8" },
  );

  // Seed resolution-evidence/.
  const evDir = join(dir, "resolution-evidence");
  await mkdir(evDir, { recursive: true });
  await writeFile(
    join(evDir, "2026-05-24T14-38-00-000Z.json"),
    JSON.stringify(
      {
        incidentId,
        verifiedAt: "2026-05-24T14:38:00Z",
        criteria: {
          metricName: "api.checkout.error_rate",
          threshold: 0.001,
          comparison: "lt",
          windowMinutes: 10,
          provider: "datadog",
          baselineComparison: "absolute",
        },
        samples: [{ timestamp: "2026-05-24T14:38:00Z", value: 0.0008 }],
        allSamplesPassed: true,
      },
      null,
      2,
    ),
  );

  // Mark resolved — use autoPostmortem=false so the fixture doesn't spawn background synthesis.
  await setIncidentStatus(rootDir, incidentId, "resolved", undefined, {
    verifyResult: {
      verified: true,
      observedValue: 0.0008,
      sampledAt: "2026-05-24T14:38:00Z",
      evidencePath: join(evDir, "2026-05-24T14-38-00-000Z.json"),
      reason: "OK",
    },
    autoPostmortem: false,
  });

  return incidentId;
}

// ── Test 1: Happy path — all template sections present ────────────────────────

describe("generatePostmortem — happy path", () => {
  it("produces a postmortem.md with all required template sections", async () => {
    const id = await makeFixtureIncident(tmpDir);
    const r = await generatePostmortem(tmpDir, id);

    expect(r.path).toMatch(/postmortem\.md$/);
    const content = await readFile(r.path, "utf-8");

    const requiredSections = [
      "# Postmortem:",
      "## TL;DR",
      "## Impact",
      "## Timeline",
      "## Root Cause",
      "## Contributing Factors",
      "## What Went Well",
      "## What Went Wrong",
      "## Action Items",
    ];
    for (const section of requiredSections) {
      expect(content, `Missing section: ${section}`).toContain(section);
    }
  });

  // ── Test 2: Citation count > 5 ────────────────────────────────────────────

  it("produces more than 5 inline citations", async () => {
    const id = await makeFixtureIncident(tmpDir);
    const r = await generatePostmortem(tmpDir, id);

    expect(r.citationCount).toBeGreaterThan(5);
    // Spot-check specific citation patterns.
    expect(r.content).toMatch(/\(timeline\.jsonl#L\d+\)/);
    expect(r.content).toMatch(/\(diagnoses\/diagnosis-/);
    expect(r.content).toContain("(incident.json)");
  });
});

// ── Test 3 + 4: 5-Whys depth ─────────────────────────────────────────────────

describe("generatePostmortem — 5-Whys depth", () => {
  it("renders 3+ Why levels when diagnosis + evidence + pre-incident changes exist (deep chain)", async () => {
    const id = await makeFixtureIncident(tmpDir);
    const r = await generatePostmortem(tmpDir, id);

    // Should NOT have shallow warning with a fully-seeded fixture.
    expect(r.shallowWarning).toBe(false);

    // All three core levels must be present.
    expect(r.content).toMatch(/^1\. Why did/m);
    expect(r.content).toMatch(/^2\. Because/m);
    expect(r.content).toMatch(/^3\. Because/m);
  });

  it("emits shallow warning when no diagnoses exist (shallow chain)", async () => {
    // Create a minimal incident with NO diagnoses.
    const id = await createIncident("shallow-case test", tmpDir);
    await setIncidentStatus(tmpDir, id, "resolved", undefined, {
      verifyResult: { verified: true, reason: "OK" },
      autoPostmortem: false,
    });
    const r = await generatePostmortem(tmpDir, id);

    expect(r.shallowWarning).toBe(true);
    expect(r.content).toContain("5-Whys synthesis was shallow");
  });
});

// ── Test 7: Redaction ─────────────────────────────────────────────────────────

describe("generatePostmortem — redaction", () => {
  it("redacts AKIA-style AWS keys from observation snippets", async () => {
    const id = await makeFixtureIncident(tmpDir);

    // Inject a fake secret into observations.jsonl.
    const fakeKeyObs: ObservationEntry = {
      timestamp: "2026-05-24T14:07:00Z",
      phase: 1,
      observation: "Found leaked credential in logs: AKIAIOSFODNN7EXAMPLE",
      source: "secrets-scanner",
      verified: true,
    };
    await appendObservation(tmpDir, id, fakeKeyObs);

    const r = await generatePostmortem(tmpDir, id);

    // The key must NOT appear in the output.
    expect(r.content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // But the placeholder must appear.
    expect(r.content).toContain("[REDACTED]");
    // Redaction counter must be > 0.
    expect(r.redactionCount).toBeGreaterThan(0);
    // Redactions footer must appear.
    expect(r.content).toMatch(/\*\*Redactions:\*\*\s+\d+\s+secret-like/);
  });
});

// ── Test 5: Auto-trigger on resolved (does not block) ────────────────────────

describe("setIncidentStatus — async postmortem trigger", () => {
  it("auto-generates postmortem AFTER status transition without blocking", async () => {
    // Create a minimal incident (no need for full fixture).
    const id = await createIncident("auto-trigger test", tmpDir);

    let pmPromise: Promise<void> | undefined;
    const start = Date.now();

    await setIncidentStatus(tmpDir, id, "resolved", undefined, {
      verifyResult: { verified: true, reason: "OK" },
      autoPostmortem: true,
      onPostmortemPromise: (p) => {
        pmPromise = p;
      },
    });

    const elapsed = Date.now() - start;

    // The status transition must return quickly (before postmortem synthesis runs).
    // We allow up to 500ms for the status write + timeline append.
    expect(elapsed).toBeLessThan(500);

    // The promise must have been set by the callback.
    expect(pmPromise).toBeDefined();

    // Await the postmortem completion and verify the file and postmortemPath field.
    await pmPromise;

    const metaRaw = await readFile(
      join(tmpDir, ".bober", "incidents", id, "incident.json"),
      "utf-8",
    );
    const meta = JSON.parse(metaRaw) as { status: string; postmortemPath?: string };

    expect(meta.status).toBe("resolved");
    expect(meta.postmortemPath).toMatch(/postmortem\.md$/);

    // The file must exist.
    await stat(meta.postmortemPath!);
  });

  // ── Test 6: autoPostmortem=false suppresses generation ────────────────────

  it("autoPostmortem=false suppresses automatic generation", async () => {
    const id = await createIncident("no-auto test", tmpDir);
    let triggered = false;

    await setIncidentStatus(tmpDir, id, "resolved", undefined, {
      verifyResult: { verified: true, reason: "OK" },
      autoPostmortem: false,
      onPostmortemPromise: () => {
        triggered = true;
      },
    });

    // The callback must NOT have been called.
    expect(triggered).toBe(false);

    // The postmortem file must NOT exist.
    const pmPath = join(tmpDir, ".bober", "incidents", id, "postmortem.md");
    await expect(stat(pmPath)).rejects.toThrow();
  });
});
