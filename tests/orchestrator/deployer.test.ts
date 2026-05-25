/**
 * Tests for Sprint 20 deploy module — change-management gates + ChangeEntry recording.
 *
 * Five critical scenarios per the sprint contract (s20-c6, s20-c7):
 *   1. Unconditional gate: autopilot + noop + risky → resolves to 'disk' floor.
 *   2. allowAutopilotRiskyActions=true: auto-approves but writes ChangeEntry + warning.
 *   3. Missing inverse: executeAction throws BEFORE execution; no ChangeEntry written.
 *   4. Multi-command Bash classification: 'echo safe && kubectl scale' → 'risky'.
 *   5. Crash-mid-execution: ChangeEntry on disk with status='pending' then 'failed'.
 *
 * Pattern mirrors tests/incident/timeline.test.ts (vitest + mkdtemp per test).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeAction } from "../../src/orchestrator/deploy/execute.js";
import { classifyCommand } from "../../src/orchestrator/deploy/classify.js";
import { resolveRiskyActionMechanismName } from "../../src/orchestrator/deploy/resolve.js";
import { createIncident } from "../../src/incident/timeline.js";
import type { ProposedAction, ExecutorSeam } from "../../src/orchestrator/deploy/types.js";
import type { ChangeEntry } from "../../src/incident/types.js";

// ── Test fixture setup ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-deploy-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function makeRiskyAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    id: "act-1",
    description: "scale api to 6",
    classification: "risky",
    reasoning: "kubectl scale is stateful and externally observable",
    command: "kubectl scale deployment api --replicas=6",
    inverse: { description: "scale back to 3", command: "kubectl scale deployment api --replicas=3" },
    ...overrides,
  };
}

// ── Scenario 1 — Unconditional gate (s20-c6) ──────────────────────────────────

describe("resolveRiskyActionMechanismName — unconditional gate (s20-c6)", () => {
  it("mode=autopilot + mechanism=noop + isRisky=true → forces 'disk' floor", () => {
    const config = { pipeline: { mode: "autopilot" as const, checkpointMechanism: "noop" as const } };
    expect(resolveRiskyActionMechanismName(config, true)).toBe("disk");
  });

  it("mode=autopilot + mechanism=noop + isRisky=false → honors 'noop' (no floor for safe actions)", () => {
    const config = { pipeline: { mode: "autopilot" as const, checkpointMechanism: "noop" as const } };
    expect(resolveRiskyActionMechanismName(config, false)).toBe("noop");
  });

  it("allowAutopilotRiskyActions=true + isRisky=true → returns configured mechanism ('noop'); caller auto-approves with warning", () => {
    const config = {
      pipeline: {
        mode: "autopilot" as const,
        checkpointMechanism: "noop" as const,
        allowAutopilotRiskyActions: true,
      },
    };
    expect(resolveRiskyActionMechanismName(config, true)).toBe("noop");
  });

  it("mode=careful + isRisky=true → resolves 'disk' (via mode default, no extra floor needed)", () => {
    const config = { pipeline: { mode: "careful" as const } };
    expect(resolveRiskyActionMechanismName(config, true)).toBe("disk");
  });
});

// ── Scenario 2 — allowAutopilotRiskyActions escape hatch (s20-c6 + s20-c7) ────

describe("executeAction — allowAutopilotRiskyActions escape hatch", () => {
  it("auto-approves risky action AND writes ChangeEntry AND logs stern warning", async () => {
    const incidentId = await createIncident("test-incident", tmpDir);
    const warnings: string[] = [];
    const executor: ExecutorSeam = {
      async run() {
        return { exitCode: 0, stdout: "scaled", stderr: "" };
      },
    };

    const result = await executeAction(
      makeRiskyAction(),
      incidentId,
      tmpDir,
      {
        pipeline: {
          mode: "autopilot" as const,
          checkpointMechanism: "noop" as const,
          allowAutopilotRiskyActions: true,
        },
      },
      { executor, writeWarn: (m) => warnings.push(m) },
    );

    // Execution succeeds (auto-approved).
    expect(result.status).toBe("executed");

    // Warning was logged.
    expect(warnings.some((w) => w.includes("allowAutopilotRiskyActions=true"))).toBe(true);
    expect(warnings.some((w) => w.includes("auto-approved risky action act-1"))).toBe(true);

    // ChangeEntry written with both pending and executed states.
    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");
    const lines = await readJsonl<ChangeEntry>(changelogPath);
    expect(lines.find((l) => l.id === "act-1" && l.status === "pending")).toBeTruthy();
    expect(lines.find((l) => l.id === "act-1" && l.status === "executed")).toBeTruthy();

    // Inverse is recorded on both entries.
    expect(lines[0].inverse.description).toBe("scale back to 3");
  });
});

// ── Scenario 3 — Missing inverse aborts before execution (s20-c7) ─────────────

describe("executeAction — missing inverse", () => {
  it("throws BEFORE execution when inverse.description is empty — no ChangeEntry written, no side effect", async () => {
    const incidentId = await createIncident("test-missing-inverse", tmpDir);
    let executed = false;
    const executor: ExecutorSeam = {
      async run() {
        executed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    await expect(
      executeAction(
        makeRiskyAction({ inverse: { description: "" } }),
        incidentId,
        tmpDir,
        { pipeline: { allowAutopilotRiskyActions: true } },
        { executor },
      ),
    ).rejects.toThrow(/inverse.*required/i);

    // Executor was NOT called.
    expect(executed).toBe(false);

    // ChangeEntry file should be empty (no lines written for the aborted action).
    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");
    const lines = await readJsonl<ChangeEntry>(changelogPath);
    expect(lines.length).toBe(0);
  });

  it("throws when inverse field is missing entirely from the action object", async () => {
    const incidentId = await createIncident("test-missing-inverse-field", tmpDir);
    const actionWithoutInverse = {
      id: "act-no-inverse",
      description: "dangerous action",
      classification: "risky" as const,
      reasoning: "this will fail",
      command: "kubectl scale deployment api --replicas=0",
      inverse: { description: "" },
    };

    await expect(
      executeAction(actionWithoutInverse, incidentId, tmpDir, { pipeline: { allowAutopilotRiskyActions: true } }),
    ).rejects.toThrow(/inverse.*required/i);
  });
});

// ── Scenario 4 — Multi-command Bash classification ────────────────────────────

describe("classifyCommand — multi-command Bash gate bypass prevention", () => {
  it("'echo safe && kubectl scale ...' → risky (s20 evaluatorNotes)", () => {
    expect(classifyCommand("echo 'safe' && kubectl scale deployment api --replicas=6")).toBe("risky");
  });

  it("'kubectl get pods -n app' → safe (read-only)", () => {
    expect(classifyCommand("kubectl get pods -n app")).toBe("safe");
  });

  it("'kubectl get pods | head' → safe (pipe to read-only command)", () => {
    expect(classifyCommand("kubectl get pods | head")).toBe("safe");
  });

  it("'rm -rf /tmp/cache' → risky", () => {
    expect(classifyCommand("rm -rf /tmp/cache")).toBe("risky");
  });

  it("'sudo systemctl restart api' → risky", () => {
    expect(classifyCommand("sudo systemctl restart api")).toBe("risky");
  });

  it("ambiguous single-word custom command → risky (default-deny)", () => {
    expect(classifyCommand("some-custom-script --apply")).toBe("risky");
  });

  it("'kubectl delete pod stuck-pod' → risky", () => {
    expect(classifyCommand("kubectl delete pod stuck-pod")).toBe("risky");
  });

  it("'git log --oneline -10' → safe", () => {
    expect(classifyCommand("git log --oneline -10")).toBe("safe");
  });

  it("'terraform apply' → risky", () => {
    expect(classifyCommand("terraform apply")).toBe("risky");
  });

  it("'curl -X POST https://api.example/scale' → risky", () => {
    expect(classifyCommand("curl -X POST https://api.example/scale")).toBe("risky");
  });

  it("'curl -I https://service.example/health' → safe", () => {
    expect(classifyCommand("curl -I https://service.example/health")).toBe("safe");
  });

  it("empty string → safe (no-op)", () => {
    expect(classifyCommand("")).toBe("safe");
  });
});

// ── Scenario 5 — Crash-mid-execution leaves ChangeEntry on disk (s20-c7) ──────

describe("executeAction — crash-mid-execution", () => {
  it("executor throws → ChangeEntry on disk with status='pending' then 'failed'", async () => {
    const incidentId = await createIncident("test-crash", tmpDir);
    const executor: ExecutorSeam = {
      async run() {
        throw new Error("simulated kubectl crash");
      },
    };

    const result = await executeAction(
      makeRiskyAction(),
      incidentId,
      tmpDir,
      { pipeline: { allowAutopilotRiskyActions: true } },
      { executor },
    );

    // Result reflects the failure.
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/simulated kubectl crash/);

    // Both ChangeEntries exist on disk — the audit trail is complete.
    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");
    const lines = await readJsonl<ChangeEntry>(changelogPath);
    expect(lines.filter((l) => l.id === "act-1").length).toBe(2);
    expect(lines.find((l) => l.id === "act-1" && l.status === "pending")).toBeTruthy();
    expect(lines.find((l) => l.id === "act-1" && l.status === "failed")).toBeTruthy();

    // Inverse is recorded on both entries (Sprint 21 rollback awareness).
    const allHaveInverse = lines.every((l) => l.id !== "act-1" || l.inverse?.description === "scale back to 3");
    expect(allHaveInverse).toBe(true);
  });

  it("executor returns non-zero exit code → status='failed'; ChangeEntry written", async () => {
    const incidentId = await createIncident("test-nonzero-exit", tmpDir);
    const executor: ExecutorSeam = {
      async run() {
        return { exitCode: 1, stdout: "", stderr: "Error from server (NotFound)" };
      },
    };

    const result = await executeAction(
      makeRiskyAction(),
      incidentId,
      tmpDir,
      { pipeline: { allowAutopilotRiskyActions: true } },
      { executor },
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/NotFound/);

    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");
    const lines = await readJsonl<ChangeEntry>(changelogPath);
    expect(lines.find((l) => l.id === "act-1" && l.status === "failed")).toBeTruthy();
  });
});

// ── Additional: safe action without checkpoint (verify no gate invoked) ────────

describe("executeAction — safe action flow", () => {
  it("safe action executes without checkpoint; ChangeEntry written with type='safe-action'", async () => {
    const incidentId = await createIncident("test-safe-action", tmpDir);
    const executor: ExecutorSeam = {
      async run() {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    };

    const safeAction: ProposedAction = {
      id: "act-safe-1",
      description: "check pod count",
      classification: "safe",
      reasoning: "kubectl get is read-only",
      command: "kubectl get pods -n app",
      inverse: { description: "no inverse needed for read-only", command: undefined },
    };

    const result = await executeAction(safeAction, incidentId, tmpDir, undefined, { executor });

    expect(result.status).toBe("executed");

    const changelogPath = join(tmpDir, ".bober", "incidents", incidentId, "changelog.jsonl");
    const lines = await readJsonl<ChangeEntry>(changelogPath);
    const executed = lines.find((l) => l.id === "act-safe-1" && l.status === "executed");
    expect(executed).toBeTruthy();
    expect(executed?.type).toBe("safe-action");
  });
});
