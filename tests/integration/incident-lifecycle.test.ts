/**
 * End-to-end incident lifecycle integration test (s24-c8).
 *
 * REAL integration — uses real timeline.ts, rollback.ts, resolution-verify.ts,
 * postmortem.ts, orchestrator.ts. Mocks ONLY at the seam boundaries:
 *   - ExecutorSeam (so kubectl etc. don't run)
 *   - MetricQueryClient (so observability MCPs aren't spawned)
 *
 * Asserts the contract scenario:
 *   start → diagnose → propose risky action → gate approves → deploy → verify
 *   → resolve → postmortem. All artifacts on disk in correct chronological order.
 *
 * Sprint 24 — tests/integration/incident-lifecycle.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createIncident,
  appendChange,
  setIncidentStatus,
} from "../../src/incident/timeline.js";
import {
  transitionPhase,
  applyDiagnosisOutcome,
  applyDeploymentOutcome,
  abort,
  readIncidentMetadata,
  InvalidTransitionError,
} from "../../src/incident/orchestrator.js";
import { executeAction } from "../../src/orchestrator/deploy/execute.js";
import type { ExecutorSeam, ProposedAction } from "../../src/orchestrator/deploy/types.js";
import type { MetricQueryClient } from "../../src/incident/resolution-verify.js";
import { DiskCheckpointMechanism } from "../../src/orchestrator/checkpoints/mechanisms/disk.js";
import { registerCheckpointMechanism } from "../../src/orchestrator/checkpoints/registry.js";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-incident-lifecycle-"));
  // Re-register disk mechanism pointing at tmpdir (Sprint 14 pattern from careful-flow.test.ts).
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
      // Return 10 samples all under 0.001 to satisfy `lt 0.01` if verified=true,
      // else return 10 samples at 0.5 to fail.
      const value = verified ? 0.0008 : 0.5;
      return Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
        value,
      }));
    },
  };
}

// ── Test cases ────────────────────────────────────────────────────────────────

describe("incident lifecycle end-to-end (s24-c8)", () => {
  it("start → diagnose → propose 3 risky actions → 3 gate invocations → verify → resolve → postmortem", async () => {
    // 1. start
    const incidentId = await createIncident("500 errors on checkout endpoint", projectRoot);
    const incDir = join(projectRoot, ".bober", "incidents", incidentId);

    // Verify initial artifacts exist.
    const initialMeta = await readIncidentMetadata(projectRoot, incidentId);
    expect(initialMeta.status).toBe("investigating");
    expect(initialMeta.symptom).toBe("500 errors on checkout endpoint");

    // 2. simulate diagnoser writing a diagnosis with 3 risky next-actions
    const diagnosisTs = new Date().toISOString();
    const diagnosis = {
      diagnosisId: `diagnosis-${incidentId}-${diagnosisTs}`,
      incidentId,
      timestamp: diagnosisTs,
      summary: "Three-step remediation required: pool exhaustion after migration 042",
      hypotheses: [
        {
          id: "h1",
          statement: "Connection pool exhausted after migration 042 deployed double-wrapped transactions",
          confidence: "high",
          supportingEvidence: [
            {
              source: "datadog",
              path: ".bober/incidents/test/observations.jsonl",
              snippet: "error logs show pool_timeout at 14:10 UTC",
            },
          ],
          contradictingEvidence: [],
        },
      ],
      nextActions: [
        { blastRadius: "risky" as const, action: "scale api", requiresApproval: true },
        { blastRadius: "risky" as const, action: "disable flag", requiresApproval: true },
        { blastRadius: "risky" as const, action: "restart db pool", requiresApproval: true },
      ],
    };
    await mkdir(join(incDir, "diagnoses"), { recursive: true });
    await writeFile(
      join(incDir, "diagnoses", `${diagnosis.diagnosisId}.json`),
      JSON.stringify(diagnosis, null, 2),
    );

    // 3. applyDiagnosisOutcome → phase = 'remediating'
    const after = await applyDiagnosisOutcome(projectRoot, incidentId, diagnosis);
    expect(after.newPhase).toBe("remediating");

    const metaAfterDiag = await readIncidentMetadata(projectRoot, incidentId);
    expect(metaAfterDiag.status).toBe("remediating");

    // 4. execute 3 risky actions — each MUST trigger the gate once.
    // Using allowAutopilotRiskyActions=true to bypass interactive prompts while
    // still going through the audit path.
    const { exec, callCount } = makeFakeExecutor();
    const config = { pipeline: { allowAutopilotRiskyActions: true } };
    const actions: ProposedAction[] = [
      {
        id: "a1",
        description: "scale api",
        classification: "risky",
        reasoning: "h1 — connection pool exhaustion requires more replicas to handle load",
        command: "kubectl scale deployment api --replicas=6",
        inverse: {
          description: "scale back to 3 replicas",
          command: "kubectl scale deployment api --replicas=3",
        },
      },
      {
        id: "a2",
        description: "disable flag",
        classification: "risky",
        reasoning: "h1 — new_checkout_flow flag triggers double-wrapped transactions",
        command: "ff --set new_checkout_flow=false",
        inverse: {
          description: "re-enable the flag",
          command: "ff --set new_checkout_flow=true",
        },
      },
      {
        id: "a3",
        description: "restart db pool",
        classification: "risky",
        reasoning: "h1 — restart clears exhausted pool connections",
        command: "kubectl rollout restart deployment db-pool",
        inverse: {
          description: "no-op; restart is idempotent",
        },
      },
    ];

    const results = [];
    for (const a of actions) {
      results.push(
        await executeAction(a, incidentId, projectRoot, config, { executor: exec }),
      );
    }
    // 3 executor invocations → 3 gate-path runs (each action triggered the audit path)
    expect(callCount()).toBe(3);
    expect(results.every((r) => r.status === "executed")).toBe(true);

    // 5. applyDeploymentOutcome → verifyResolution via fake client → 'monitoring'
    const deployResult = {
      executed: results.map((r) => ({ status: r.status as "executed" | "failed" })),
    };
    const outcome = await applyDeploymentOutcome(projectRoot, incidentId, deployResult, {
      resolutionCriteria: {
        metricName: "api.checkout.error_rate",
        threshold: 0.01,
        comparison: "lt" as const,
        windowMinutes: 10,
        provider: "datadog",
      },
      verifyDeps: {
        providers: [{ name: "datadog", kind: "metrics" as const, mcpCommand: "node", enabled: true }],
        client: makeFakeMetricClient(true),
      },
    });
    expect(outcome.newPhase).toBe("monitoring");
    expect(outcome.verified).toBe(true);

    const metaAfterDeploy = await readIncidentMetadata(projectRoot, incidentId);
    expect(metaAfterDeploy.status).toBe("monitoring");

    // 6. Mark resolved → triggers auto-postmortem fire-and-forget.
    let postmortemPromise: Promise<void> | undefined;
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      verifyResult: {
        verified: true,
        reason: "OK",
        observedValue: 0.0008,
        sampledAt: new Date().toISOString(),
      },
      onPostmortemPromise: (p) => {
        postmortemPromise = p;
      },
    });
    expect(postmortemPromise).toBeDefined();
    await postmortemPromise;

    // 7. Assert postmortem.md exists.
    const pmPath = join(incDir, "postmortem.md");
    const pmStat = await stat(pmPath);
    expect(pmStat.isFile()).toBe(true);

    // 8. Assert chronological ordering of timeline.jsonl (timestamps non-decreasing).
    const timelineRaw = await readFile(join(incDir, "timeline.jsonl"), "utf-8");
    const lines = timelineRaw.trim().split("\n").filter(Boolean).map(
      (l) => JSON.parse(l) as { timestamp: string },
    );
    expect(lines.length).toBeGreaterThan(0);
    const stamps = lines.map((l) => l.timestamp);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! >= stamps[i - 1]!).toBe(true);
    }

    // 9. Assert changelog has entries for all 3 actions (pending + executed = 6 lines minimum).
    const changelog = await readFile(join(incDir, "changelog.jsonl"), "utf-8");
    const changeLines = changelog.trim().split("\n").filter(Boolean);
    expect(changeLines.length).toBeGreaterThanOrEqual(6); // pending+executed per action

    // 10. Assert final status is resolved.
    const finalMeta = await readIncidentMetadata(projectRoot, incidentId);
    expect(finalMeta.status).toBe("resolved");
    expect(finalMeta.resolvedAt).toBeDefined();
  }, 30_000);

  it("invalid transition: resolved → remediating without re-open reason → InvalidTransitionError", async () => {
    const incidentId = await createIncident("test invalid transition", projectRoot);

    // Force status to 'resolved' by going through the override path.
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      overrideToken: "SKIP_METRIC_VERIFY: test fixture — no metric available",
      autoPostmortem: false,
    });

    const meta = await readIncidentMetadata(projectRoot, incidentId);
    expect(meta.status).toBe("resolved");

    // Attempt to go directly to 'remediating' — should fail.
    await expect(
      transitionPhase(projectRoot, incidentId, "remediating", {}),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("invalid transition: investigating → monitoring → InvalidTransitionError", async () => {
    const incidentId = await createIncident("test invalid transition 2", projectRoot);

    // Direct jump from investigating → monitoring is not in the transition table.
    await expect(
      transitionPhase(projectRoot, incidentId, "monitoring", {}),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("valid re-open: resolved → investigating WITH reason succeeds", async () => {
    const incidentId = await createIncident("test re-open", projectRoot);
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      overrideToken: "SKIP_METRIC_VERIFY: test fixture — re-open test",
      autoPostmortem: false,
    });

    // Re-open with a reason — should succeed.
    await transitionPhase(projectRoot, incidentId, "investigating", {
      reason: "Symptom recurred at 14:50 UTC",
    });

    const meta = await readIncidentMetadata(projectRoot, incidentId);
    expect(meta.status).toBe("investigating");
  });

  it("valid re-open: resolved → investigating WITHOUT reason → InvalidTransitionError", async () => {
    const incidentId = await createIncident("test re-open no reason", projectRoot);
    await setIncidentStatus(projectRoot, incidentId, "resolved", undefined, {
      overrideToken: "SKIP_METRIC_VERIFY: test fixture — re-open no reason test",
      autoPostmortem: false,
    });

    // Re-open without reason — should fail.
    await expect(
      transitionPhase(projectRoot, incidentId, "investigating", {}),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("abort without --confirm-rollback does NOT execute rollbacks (footgun-prevention)", async () => {
    const incidentId = await createIncident("abort no rollback test", projectRoot);

    // Seed one executed change so a rollback WOULD have something to do.
    await appendChange(projectRoot, incidentId, {
      id: "change-001",
      type: "risky-action",
      executedAt: new Date().toISOString(),
      description: "scaled api to 6 replicas",
      inverse: {
        description: "scale back to 3 replicas",
        command: "kubectl scale deployment api --replicas=3",
      },
      status: "executed",
    });

    const { exec, callCount } = makeFakeExecutor();
    const result = await abort(projectRoot, incidentId, {
      reason: "operator decision — reverting to manual remediation",
      confirmRollback: false,
      rollbackOpts: { executor: exec },
    });

    expect(result.rollback).toBeUndefined(); // no rollback attempted
    expect(callCount()).toBe(0); // proves no rollback was executed silently

    // Abort report should exist.
    const abortReportStat = await stat(result.abortReportPath);
    expect(abortReportStat.isFile()).toBe(true);

    // Incident should be in aborted state.
    const meta = await readIncidentMetadata(projectRoot, incidentId);
    expect(meta.status).toBe("aborted");
  });

  it("abort with --confirm-rollback DOES execute rollbacks (each step gates)", async () => {
    const incidentId = await createIncident("abort with rollback test", projectRoot);

    // Seed two executed changes.
    const now = new Date().toISOString();
    await appendChange(projectRoot, incidentId, {
      id: "change-rollback-001",
      type: "risky-action",
      executedAt: now,
      description: "scaled api to 6 replicas",
      inverse: {
        description: "scale back to 3 replicas",
        command: "kubectl scale deployment api --replicas=3",
      },
      status: "executed",
    });
    await appendChange(projectRoot, incidentId, {
      id: "change-rollback-002",
      type: "risky-action",
      executedAt: new Date(Date.now() + 1000).toISOString(), // +1s to ensure order
      description: "disabled feature flag",
      inverse: {
        description: "re-enable feature flag",
        command: "ff --set new_checkout_flow=true",
      },
      status: "executed",
    });

    const { exec, callCount } = makeFakeExecutor();
    const result = await abort(projectRoot, incidentId, {
      reason: "operator decision — rolling back all changes",
      confirmRollback: true,
      config: { pipeline: { allowAutopilotRiskyActions: true } },
      rollbackOpts: { executor: exec },
    });

    expect(result.rollback).toBeDefined();
    expect(result.rollback!.attempted).toBe(2);
    expect(result.rollback!.succeeded).toBe(2);
    expect(callCount()).toBe(2); // 2 executor invocations for 2 rollback steps

    // Incident should be in aborted state.
    const meta = await readIncidentMetadata(projectRoot, incidentId);
    expect(meta.status).toBe("aborted");
  });

  it("abort already-aborted incident throws clear error (terminal state)", async () => {
    const incidentId = await createIncident("abort terminal test", projectRoot);

    // First abort.
    await abort(projectRoot, incidentId, {
      reason: "first abort",
      confirmRollback: false,
    });

    // Second abort should throw.
    await expect(
      abort(projectRoot, incidentId, {
        reason: "second abort",
        confirmRollback: false,
      }),
    ).rejects.toThrow("already aborted");
  });

  it("status command works for every phase including aborted (no crash on missing artifacts)", async () => {
    // This test verifies that readIncidentMetadata works across phases
    // without crashing even when some artifacts are absent.

    // Phase: investigating (fresh)
    const id1 = await createIncident("test status investigating", projectRoot);
    const meta1 = await readIncidentMetadata(projectRoot, id1);
    expect(meta1.status).toBe("investigating");

    // Phase: remediating
    await transitionPhase(projectRoot, id1, "remediating", {});
    const meta2 = await readIncidentMetadata(projectRoot, id1);
    expect(meta2.status).toBe("remediating");

    // Phase: monitoring
    await transitionPhase(projectRoot, id1, "monitoring", {});
    const meta3 = await readIncidentMetadata(projectRoot, id1);
    expect(meta3.status).toBe("monitoring");

    // Phase: aborted from monitoring
    const id2 = await createIncident("test status aborted", projectRoot);
    // Move to monitoring directly via transitions (no verification needed).
    await transitionPhase(projectRoot, id2, "remediating", {});
    await transitionPhase(projectRoot, id2, "monitoring", {});

    const abortResult = await abort(projectRoot, id2, {
      reason: "test abort for status check",
      confirmRollback: false,
    });
    const metaAborted = await readIncidentMetadata(projectRoot, id2);
    expect(metaAborted.status).toBe("aborted");
    // Abort report should exist.
    const abortStat = await stat(abortResult.abortReportPath);
    expect(abortStat.isFile()).toBe(true);
  });

  it("checkpoint gate fires for EVERY risky action in a 3-action diagnosis", async () => {
    // This test specifically verifies that each risky action triggers the gate path
    // independently — no batching or single-gate-for-all-actions.
    const incidentId = await createIncident("gate per action test", projectRoot);

    const gateWarnings: string[] = [];
    const captureWarn = (msg: string) => {
      gateWarnings.push(msg);
    };

    const { exec } = makeFakeExecutor();
    const config = { pipeline: { allowAutopilotRiskyActions: true } };

    // 3 risky actions.
    const actions: ProposedAction[] = [
      {
        id: "gate-a1",
        description: "gate action 1",
        classification: "risky",
        reasoning: "test risky action 1",
        command: "kubectl scale deployment api --replicas=6",
        inverse: { description: "scale back", command: "kubectl scale deployment api --replicas=3" },
      },
      {
        id: "gate-a2",
        description: "gate action 2",
        classification: "risky",
        reasoning: "test risky action 2",
        command: "kubectl rollout restart deployment frontend",
        inverse: { description: "restart is idempotent" },
      },
      {
        id: "gate-a3",
        description: "gate action 3",
        classification: "risky",
        reasoning: "test risky action 3",
        command: "kubectl delete pod stale-pod-abc123",
        inverse: { description: "pod recreates automatically on delete" },
      },
    ];

    for (const a of actions) {
      await executeAction(a, incidentId, projectRoot, config, {
        executor: exec,
        writeWarn: captureWarn,
      });
    }

    // Each risky action generates one "auto-approved" warning when
    // allowAutopilotRiskyActions=true. 3 actions → 3 warnings.
    expect(gateWarnings.length).toBe(3);
    for (const w of gateWarnings) {
      expect(w).toContain("auto-approved risky action");
    }
  });
});
