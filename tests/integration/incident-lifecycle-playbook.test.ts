/**
 * Tier 3 completion-gate integration test (s25-c9).
 *
 * Verifies the full incident workflow with a playbook-matched symptom:
 *   incident with symptom "build is failing in ci"
 *   → searchPlaybooks → high-confidence match for build-failure
 *   → diagnosis → deploy → verify → resolve → postmortem
 *
 * Uses the same seam pattern as incident-lifecycle.test.ts (Sprint 24):
 *   - ExecutorSeam mock (no real kubectl)
 *   - MetricQueryClient mock (no real observability MCP)
 *
 * Sprint 25 — tests/integration/incident-lifecycle-playbook.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createIncident,
  setIncidentStatus,
} from "../../src/incident/timeline.js";
import {
  applyDiagnosisOutcome,
  applyDeploymentOutcome,
  readIncidentMetadata,
} from "../../src/incident/orchestrator.js";
import { executeAction } from "../../src/orchestrator/deploy/execute.js";
import type { ExecutorSeam, ProposedAction } from "../../src/orchestrator/deploy/types.js";
import type { MetricQueryClient } from "../../src/incident/resolution-verify.js";
import {
  searchPlaybooks,
  HIGH_CONFIDENCE_THRESHOLD,
} from "../../src/incident/playbook-search.js";
import { DiskCheckpointMechanism } from "../../src/orchestrator/checkpoints/mechanisms/disk.js";
import { registerCheckpointMechanism } from "../../src/orchestrator/checkpoints/registry.js";

// ── Repo root (for loading actual .bober/playbooks/ files) ───────────────────

const repoRoot = resolve(join(import.meta.url.replace("file://", ""), "../../.."));

// ── Temp directory fixture ─────────────────────────────────────────────────────

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-incident-playbook-"));
  registerCheckpointMechanism(
    "disk",
    new DiskCheckpointMechanism(join(projectRoot, ".bober", "approvals"), {
      pollMs: 50,
      timeoutMs: 10_000,
    }),
  );
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

// ── Test seams ────────────────────────────────────────────────────────────────

function makeFakeExecutor(): { exec: ExecutorSeam; callCount: () => number } {
  let n = 0;
  return {
    exec: {
      async run(_command: string) {
        n += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    callCount: () => n,
  };
}

function makeFakeMetricClient(verified: boolean): MetricQueryClient {
  return {
    async queryMetric() {
      const value = verified ? 0.0008 : 0.5;
      return Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        value,
      }));
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("incident lifecycle with playbook match (s25-c9)", () => {
  it("symptom 'build is failing in ci' → high-confidence match for build-failure", async () => {
    const symptom = "build is failing in ci";
    const matches = await searchPlaybooks(symptom, repoRoot);
    const bfMatch = matches.find((m) => m.playbook.name === "build-failure");
    expect(bfMatch).toBeDefined();
    expect(bfMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });

  it("build-failure playbook has ≥5 steps and correct classification", async () => {
    const matches = await searchPlaybooks("build is failing in ci", repoRoot);
    const bfMatch = matches.find((m) => m.playbook.name === "build-failure");
    expect(bfMatch).toBeDefined();
    expect(bfMatch!.playbook.classification).toBe("standard");
    expect(bfMatch!.playbook.stepSections.length).toBeGreaterThanOrEqual(5);
  });

  it("full lifecycle: create incident → playbook matched → diagnose → deploy → verify → resolve → postmortem", async () => {
    // 1. Create incident with build-failure symptom
    const symptom = "build is failing in ci";
    const incidentId = await createIncident(symptom, projectRoot);
    const incDir = join(projectRoot, ".bober", "incidents", incidentId);

    const initialMeta = await readIncidentMetadata(projectRoot, incidentId);
    expect(initialMeta.status).toBe("investigating");
    expect(initialMeta.symptom).toBe(symptom);

    // 2. Playbook search (as the diagnoser would do in Step 0)
    const matches = await searchPlaybooks(symptom, repoRoot);
    const bfMatch = matches.find((m) => m.playbook.name === "build-failure");
    expect(bfMatch).toBeDefined();
    expect(bfMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);

    // 3. Simulate diagnoser writing a diagnosis referencing the matched playbook
    const diagnosisTs = new Date().toISOString();
    const diagnosis = {
      diagnosisId: `diagnosis-${incidentId}-${diagnosisTs}`,
      incidentId,
      timestamp: diagnosisTs,
      summary: `Playbook matched: build-failure (confidence: ${bfMatch!.confidence.toFixed(2)}). ` +
        "Root cause: compilation error in recent commit causing CI failure.",
      hypotheses: [
        {
          id: "h1",
          statement: "Recent commit introduced a compilation error causing the CI pipeline to fail",
          confidence: "high",
          supportingEvidence: [
            {
              source: "ci-logs",
              path: ".bober/incidents/test/observations.jsonl",
              snippet: "TypeScript error TS2345 at src/api/handler.ts:42",
            },
          ],
          contradictingEvidence: [],
        },
      ],
      nextActions: [
        {
          blastRadius: "risky" as const,
          action: "trigger CI re-run after fixing compilation error",
          requiresApproval: true,
        },
      ],
      playbookMatch: {
        name: "build-failure",
        confidence: bfMatch!.confidence,
        matchedTokens: bfMatch!.matchedTokens,
      },
    };
    await mkdir(join(incDir, "diagnoses"), { recursive: true });
    await writeFile(
      join(incDir, "diagnoses", `${diagnosis.diagnosisId}.json`),
      JSON.stringify(diagnosis, null, 2),
    );

    // 4. applyDiagnosisOutcome → phase = 'remediating'
    const after = await applyDiagnosisOutcome(projectRoot, incidentId, diagnosis);
    expect(after.newPhase).toBe("remediating");

    const metaAfterDiag = await readIncidentMetadata(projectRoot, incidentId);
    expect(metaAfterDiag.status).toBe("remediating");

    // 5. Execute the risky remediation action
    const { exec, callCount } = makeFakeExecutor();
    const config = { pipeline: { allowAutopilotRiskyActions: true } };
    const actions: ProposedAction[] = [
      {
        id: "a-build-fix",
        description: "trigger CI re-run after fixing compilation error",
        classification: "risky",
        reasoning: "h1 — compilation error fixed in follow-up commit; re-run to verify green build",
        command: "gh workflow run ci.yml --ref main",
        inverse: {
          description: "no automated inverse; CI runs are idempotent",
        },
      },
    ];

    const results = [];
    for (const a of actions) {
      results.push(
        await executeAction(a, incidentId, projectRoot, config, { executor: exec }),
      );
    }
    expect(callCount()).toBe(1);
    expect(results[0]!.status).toBe("executed");

    // 6. applyDeploymentOutcome → verify → 'monitoring'
    const deployResult = {
      executed: results.map((r) => ({ status: r.status as "executed" | "failed" })),
    };
    const outcome = await applyDeploymentOutcome(projectRoot, incidentId, deployResult, {
      resolutionCriteria: {
        metricName: "ci.build.error_rate",
        threshold: 0.01,
        comparison: "lt" as const,
        windowMinutes: 5,
        provider: "github",
      },
      verifyDeps: {
        providers: [
          { name: "github", kind: "metrics" as const, mcpCommand: "node", enabled: true },
        ],
        client: makeFakeMetricClient(true),
      },
    });
    expect(outcome.newPhase).toBe("monitoring");
    expect(outcome.verified).toBe(true);

    // 7. Mark resolved → triggers auto-postmortem
    let postmortemPromise: Promise<void> | undefined;
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      verifyResult: {
        verified: true,
        reason: "OK",
        observedValue: 0.98,
        sampledAt: new Date().toISOString(),
      },
      onPostmortemPromise: (p) => {
        postmortemPromise = p;
      },
    });
    expect(postmortemPromise).toBeDefined();
    await postmortemPromise;

    // 8. Assert postmortem.md exists
    const pmPath = join(incDir, "postmortem.md");
    const pmStat = await stat(pmPath);
    expect(pmStat.isFile()).toBe(true);

    // 9. Assert final status is resolved
    const finalMeta = await readIncidentMetadata(projectRoot, incidentId);
    expect(finalMeta.status).toBe("resolved");
    expect(finalMeta.resolvedAt).toBeDefined();

    // 10. Verify timeline.jsonl has events in chronological order
    const timelineRaw = await readFile(
      join(incDir, "timeline.jsonl"),
      "utf-8",
    );
    const lines = timelineRaw.trim().split("\n").filter(Boolean).map(
      (l) => JSON.parse(l) as { timestamp: string },
    );
    expect(lines.length).toBeGreaterThan(0);
    const stamps = lines.map((l) => l.timestamp);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! >= stamps[i - 1]!).toBe(true);
    }
  }, 30_000);

  it("build-failure matched playbook has standard classification (not emergency)", async () => {
    // build-failure is standard — it should not be classified emergency
    const matches = await searchPlaybooks("build is failing in ci", repoRoot);
    const bfMatch = matches.find((m) => m.playbook.name === "build-failure");
    expect(bfMatch).toBeDefined();
    expect(bfMatch!.playbook.classification).toBe("standard");
    // migration-timeout is emergency by contrast
    const mtMatches = await searchPlaybooks("db migration stuck", repoRoot);
    const mtMatch = mtMatches.find((m) => m.playbook.name === "migration-timeout");
    expect(mtMatch).toBeDefined();
    expect(mtMatch!.playbook.classification).toBe("emergency");
  });

  it("searchPlaybooks result for 'build is failing in ci' ranks build-failure first", async () => {
    const matches = await searchPlaybooks("build is failing in ci", repoRoot);
    expect(matches.length).toBeGreaterThan(0);
    // build-failure should be the top result for this query
    expect(matches[0]!.playbook.name).toBe("build-failure");
    expect(matches[0]!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });
});
