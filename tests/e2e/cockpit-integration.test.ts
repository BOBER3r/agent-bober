/**
 * Cockpit integration end-to-end test (Sprint 6).
 *
 * Spawns a REAL `node dist/cli/index.js mcp` subprocess, performs the MCP
 * initialize handshake, then exercises every tool introduced by Sprints 1-6.
 *
 * BOBER_TEST_DETERMINISTIC=1 is passed to the subprocess to suppress real LLM calls
 * (see src/providers/factory.ts DeterministicStubClient).
 *
 * ── SANITY SABOTAGE INSTRUCTIONS ───────────────────────────────────────────────
 * To verify the test fails loudly when a tool is missing:
 *   1. In src/mcp/tools/index.ts, comment out `registerAbortRunTool()`.
 *   2. Run: `npm run build && npx vitest run tests/e2e/cockpit-integration.test.ts`
 *   3. Expect: sc-6-5 should fail with "bober_abort_run not found in tools/list".
 *      NOT a cryptic timeout.
 *   4. Restore the registration.
 * ───────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat, cp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "cockpit-baseline");

// ── Shared state ──────────────────────────────────────────────────────────────

let projectRoot: string;
let client: Client;
let transport: StdioClientTransport;

// ── Build guard ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  try {
    await stat(CLI_ENTRY);
  } catch {
    await execa("npm", ["run", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
}, 120_000);

// ── Per-test lifecycle ─────────────────────────────────────────────────────────

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "bober-cockpit-e2e-"));

  // Copy fixture into fresh tmpdir
  await cp(FIXTURE_DIR, projectRoot, { recursive: true });

  // Initialize a git repo so worktree operations work
  await execa("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
  await execa(
    "git",
    ["-c", "user.email=test@bober.test", "-c", "user.name=Bober Test", "add", "."],
    { cwd: projectRoot },
  );
  await execa(
    "git",
    ["-c", "user.email=test@bober.test", "-c", "user.name=Bober Test", "commit", "-q", "-m", "init fixture"],
    { cwd: projectRoot },
  );

  // Pre-create .bober/ structure so the server starts cleanly
  await mkdir(join(projectRoot, ".bober"), { recursive: true });
  await writeFile(join(projectRoot, ".bober", "history.jsonl"), "");

  // Spawn the MCP server subprocess
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "mcp"],
    env: {
      ...process.env,
      BOBER_TEST_DETERMINISTIC: "1",
    },
    cwd: projectRoot,
    stderr: "pipe",
  });

  client = new Client(
    { name: "fake-cockpit-client", version: "0.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  // Wait for the server's post-connect initialization to complete.
  // The MCP server calls loadConfig (async) and initEventStream AFTER server.connect()
  // resolves. Polling listTools until the server responds ensures we don't race
  // with initEventStream when the first test calls bober_subscribe_events.
  const serverReadyDeadline = Date.now() + 5000;
  while (Date.now() < serverReadyDeadline) {
    try {
      await client.listTools();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Small extra buffer for initEventStream to run (async post-connect hook)
  await new Promise((r) => setTimeout(r, 200));
});

afterEach(async () => {
  await client.close().catch(() => {});
  await rm(projectRoot, { recursive: true, force: true });
});

// ── Helper: parse tool response content ──────────────────────────────────────

function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  if (!content || content.length === 0) return null;
  const text = content[0]!.text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("cockpit-integration end-to-end (Sprint 6)", () => {
  // ── sc-6-5: Tool list handshake ─────────────────────────────────────────────
  it("sc-6-5: initialize handshake; every Sprint 1-6 tool is registered", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    const EXPECTED_SPRINT_1_2_TOOLS = [
      "bober_list_active_runs",
      "bober_get_run_status",
      "bober_abort_run",
    ];
    const EXPECTED_SPRINT_3_TOOLS = [
      "bober_subscribe_events",
      "bober_unsubscribe_events",
    ];
    const EXPECTED_SPRINT_4_TOOLS = [
      "bober_run_in_worktree",
    ];
    const EXPECTED_SPRINT_5_TOOLS = [
      "bober_list_pending_approvals",
      "bober_approve_checkpoint",
      "bober_reject_checkpoint",
      "bober_list_projects",
      "bober_list_specs",
      "bober_get_project_state",
    ];
    const EXPECTED_SPRINT_6_TOOLS = [
      "bober_incident_start",
      "bober_incident_status",
      "bober_incident_list",
      "bober_incident_abort",
      "bober_rollback_start",
      "bober_postmortem_get",
      "bober_playbook_list",
      "bober_playbook_search",
    ];

    const ALL_EXPECTED = [
      ...EXPECTED_SPRINT_1_2_TOOLS,
      ...EXPECTED_SPRINT_3_TOOLS,
      ...EXPECTED_SPRINT_4_TOOLS,
      ...EXPECTED_SPRINT_5_TOOLS,
      ...EXPECTED_SPRINT_6_TOOLS,
    ];

    for (const name of ALL_EXPECTED) {
      expect(names, `Expected tool ${name} to be registered`).toContain(name);
    }

    // Verify at least 37 tools registered
    expect(names.length).toBeGreaterThanOrEqual(37);
  }, 30_000);

  // ── sc-6-6: Scenario A — multi-run lifecycle ────────────────────────────────
  it("sc-6-6: scenario A — multi-run: list→spawn→list→status→abort", async () => {
    // Step 1: Initially no active runs
    const emptyList = parseToolResult(
      await client.callTool({ name: "bober_list_active_runs", arguments: {} }),
    ) as Array<unknown>;
    expect(Array.isArray(emptyList)).toBe(true);
    expect(emptyList.length).toBe(0);

    // Step 2: Spawn a worktree run
    const spawnResult = parseToolResult(
      await client.callTool({
        name: "bober_run_in_worktree",
        arguments: { task: "e2e-test-task" },
      }),
    ) as { runId: string; branch: string; worktreePath: string; status: string };

    // Should return { runId, branch, worktreePath, status: 'running' }
    expect(spawnResult).toMatchObject({ status: "running" });
    expect(typeof spawnResult.runId).toBe("string");
    expect(spawnResult.runId.length).toBeGreaterThan(0);
    const { runId } = spawnResult;

    // Step 3: The run should appear in list (may be running or completed/failed by now)
    // Omit status filter to return ALL runs regardless of status
    const runList = parseToolResult(
      await client.callTool({ name: "bober_list_active_runs", arguments: {} }),
    ) as Array<{ runId: string; status: string }>;
    expect(Array.isArray(runList)).toBe(true);
    const listedRun = runList.find((r) => r.runId === runId);
    expect(listedRun).toBeDefined();

    // Step 4: Get run status — should have the correct shape
    const statusResult = parseToolResult(
      await client.callTool({
        name: "bober_get_run_status",
        arguments: { runId },
      }),
    ) as { runId: string; status: string; startedAt: string };
    expect(statusResult).toMatchObject({ runId });
    expect(typeof statusResult.status).toBe("string");
    expect(typeof statusResult.startedAt).toBe("string");

    // Step 5: Abort — if still running, should flip to aborted
    // If already completed/failed, soft-error is returned (that's OK per the design)
    const abortResult = parseToolResult(
      await client.callTool({
        name: "bober_abort_run",
        arguments: { runId, reason: "e2e test cleanup" },
      }),
    ) as { runId?: string; status?: string; error?: string };

    // Either aborted or already completed (both are valid end states)
    if (abortResult.error) {
      // Run completed before we could abort — that's OK, it was tracked
      expect(typeof abortResult.error).toBe("string");
    } else {
      expect(abortResult).toMatchObject({ runId, status: "aborted" });
    }
  }, 60_000);

  // ── sc-6-7: Scenario B — events subscribe/unsubscribe ───────────────────────
  it("sc-6-7: scenario B — subscribe events, assert notification, unsubscribe", async () => {
    const receivedNotifications: Notification[] = [];
    client.fallbackNotificationHandler = async (notification: Notification) => {
      receivedNotifications.push(notification);
    };

    // Subscribe to a run's events
    const subscribeResult = parseToolResult(
      await client.callTool({
        name: "bober_subscribe_events",
        arguments: { runId: "e2e-events-test-run" },
      }),
    ) as { subscriptionId: string; status: string };

    expect(subscribeResult).toMatchObject({ status: "subscribed" });
    expect(typeof subscribeResult.subscriptionId).toBe("string");
    const { subscriptionId } = subscribeResult;

    // Append a matching event to history.jsonl to trigger a notification
    const historyEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "sprint-started",
      phase: "planning",
      runId: "e2e-events-test-run",
      details: {},
    }) + "\n";

    const historyPath = join(projectRoot, ".bober", "history.jsonl");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(historyPath, historyEntry);

    // Wait up to 5s for at least one notification
    const deadline = Date.now() + 5000;
    while (receivedNotifications.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(receivedNotifications.length).toBeGreaterThan(0);
    const notif = receivedNotifications[0] as unknown as {
      method: string;
      params: { subscriptionId: string };
    };
    expect(notif.method).toBe("bober/events");

    // Unsubscribe
    const unsubResult = parseToolResult(
      await client.callTool({
        name: "bober_unsubscribe_events",
        arguments: { subscriptionId },
      }),
    ) as { status: string };
    expect(unsubResult).toMatchObject({ status: "unsubscribed" });

    // Record count before
    const countBefore = receivedNotifications.length;

    // Append another event after unsubscribe — should NOT trigger a notification
    await appendFile(historyPath, historyEntry);
    await new Promise((r) => setTimeout(r, 500));

    // No new notifications should have arrived
    expect(receivedNotifications.length).toBe(countBefore);
  }, 30_000);

  // ── sc-6-8: Scenario C — careful-flow approve + reject ──────────────────────
  it("sc-6-8: scenario C — careful-flow: write pending → approve; write pending → reject", async () => {
    const approvalsDir = join(projectRoot, ".bober", "approvals");
    await mkdir(approvalsDir, { recursive: true });

    // ── Approve flow ─────────────────────────────────────────────────────────
    const checkpointIdA = "cp-approve-test-1";
    const pendingMarkerA = {
      checkpointId: checkpointIdA,
      artifact: { type: "research-doc" },
      prompt: "Please review the research findings",
      requestedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(
      join(approvalsDir, `${checkpointIdA}.pending.json`),
      JSON.stringify(pendingMarkerA, null, 2),
      "utf-8",
    );

    // List pending — should see our checkpoint
    const pendingList = parseToolResult(
      await client.callTool({
        name: "bober_list_pending_approvals",
        arguments: { projectPath: projectRoot },
      }),
    ) as Array<{ checkpointId: string; prompt: string }>;
    expect(Array.isArray(pendingList)).toBe(true);
    expect(pendingList.some((p) => p.checkpointId === checkpointIdA)).toBe(true);

    // Approve the checkpoint
    const approveResult = parseToolResult(
      await client.callTool({
        name: "bober_approve_checkpoint",
        arguments: { checkpointId: checkpointIdA, projectPath: projectRoot },
      }),
    ) as { approvedAt: string; checkpointId: string };
    expect(approveResult).toMatchObject({ checkpointId: checkpointIdA });
    expect(typeof approveResult.approvedAt).toBe("string");

    // Verify the .approved.json file was written
    const { readFile: readFileNode } = await import("node:fs/promises");
    const approvedContent = JSON.parse(
      await readFileNode(join(approvalsDir, `${checkpointIdA}.approved.json`), "utf-8"),
    ) as { approvedAt: string; approverId: string };
    expect(typeof approvedContent.approvedAt).toBe("string");
    expect(typeof approvedContent.approverId).toBe("string");

    // ── Reject flow ──────────────────────────────────────────────────────────
    const checkpointIdB = "cp-reject-test-2";
    const pendingMarkerB = {
      checkpointId: checkpointIdB,
      artifact: { type: "sprint-contract" },
      prompt: "Please review the sprint contract",
      requestedAt: new Date().toISOString(),
      timeoutAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await writeFile(
      join(approvalsDir, `${checkpointIdB}.pending.json`),
      JSON.stringify(pendingMarkerB, null, 2),
      "utf-8",
    );

    const rejectResult = parseToolResult(
      await client.callTool({
        name: "bober_reject_checkpoint",
        arguments: {
          checkpointId: checkpointIdB,
          projectPath: projectRoot,
          feedback: "The contract needs more detail on error handling",
        },
      }),
    ) as { rejectedAt: string; checkpointId: string };
    expect(rejectResult).toMatchObject({ checkpointId: checkpointIdB });
    expect(typeof rejectResult.rejectedAt).toBe("string");

    // Verify the .rejected.json file was written
    const rejectedContent = JSON.parse(
      await readFileNode(join(approvalsDir, `${checkpointIdB}.rejected.json`), "utf-8"),
    ) as { rejectedAt: string; feedback: string };
    expect(typeof rejectedContent.rejectedAt).toBe("string");
    expect(rejectedContent.feedback).toBe("The contract needs more detail on error handling");
  }, 30_000);

  // ── sc-6-9: Scenario D — discovery ──────────────────────────────────────────
  it("sc-6-9: scenario D — discovery: list_projects → list_specs → get_project_state", async () => {
    // bober_list_projects with parent directory of projectRoot as searchRoot
    // projectRoot itself has bober.config.json, so we search its parent
    const parentDir = dirname(projectRoot);
    const projectsResult = parseToolResult(
      await client.callTool({
        name: "bober_list_projects",
        arguments: { searchRoots: [parentDir] },
      }),
    ) as Array<{ projectPath: string; name: string }>;

    expect(Array.isArray(projectsResult)).toBe(true);
    const foundFixture = projectsResult.find(
      (p) => p.projectPath === projectRoot,
    );
    expect(foundFixture).toBeDefined();
    expect(foundFixture!.name).toBe("cockpit-baseline");

    // bober_list_specs — fixture has one seeded spec
    const specsResult = parseToolResult(
      await client.callTool({
        name: "bober_list_specs",
        arguments: { projectPath: projectRoot },
      }),
    ) as Array<{ specId: string; title: string; status: string }>;

    expect(Array.isArray(specsResult)).toBe(true);
    expect(specsResult.length).toBeGreaterThanOrEqual(1);
    const seededSpec = specsResult.find((s) => s.specId === "spec-cockpit-baseline-1");
    expect(seededSpec).toBeDefined();
    expect(seededSpec!.title).toBe("Cockpit Baseline Spec");

    // bober_get_project_state — aggregate counts
    const stateResult = parseToolResult(
      await client.callTool({
        name: "bober_get_project_state",
        arguments: { projectPath: projectRoot },
      }),
    ) as {
      specCount: number;
      pendingApprovalCount: number;
      activeRunCount: number;
      configExists: boolean;
      openIncidentCount: number;
    };

    expect(typeof stateResult.specCount).toBe("number");
    expect(stateResult.specCount).toBeGreaterThanOrEqual(1);
    expect(typeof stateResult.pendingApprovalCount).toBe("number");
    expect(typeof stateResult.activeRunCount).toBe("number");
    expect(stateResult.configExists).toBe(true);
  }, 30_000);

  // ── sc-6-10: Scenario E — vision-era incident lifecycle ─────────────────────
  it("sc-6-10: scenario E — incident lifecycle: start → list → status → abort", async () => {
    // Start an incident
    const startResult = parseToolResult(
      await client.callTool({
        name: "bober_incident_start",
        arguments: {
          symptom: "API error rate spiking above 5%",
          severity: "S2",
          projectPath: projectRoot,
        },
      }),
    ) as { incidentId: string; status: string; createdAt: string; severity?: string };

    expect(startResult).toMatchObject({ status: "investigating" });
    expect(startResult.incidentId).toMatch(/^inc-/);
    expect(typeof startResult.createdAt).toBe("string");
    const { incidentId } = startResult;

    // List incidents — should see our incident
    const listResult = parseToolResult(
      await client.callTool({
        name: "bober_incident_list",
        arguments: { projectPath: projectRoot },
      }),
    ) as Array<{ incidentId: string; symptom: string; status: string }>;

    expect(Array.isArray(listResult)).toBe(true);
    const listed = listResult.find((i) => i.incidentId === incidentId);
    expect(listed).toBeDefined();
    expect(listed!).toMatchObject({ status: "investigating" });

    // Get incident status
    const statusResult = parseToolResult(
      await client.callTool({
        name: "bober_incident_status",
        arguments: { incidentId, projectPath: projectRoot },
      }),
    ) as { incidentId: string; symptom: string; status: string };

    expect(statusResult).toMatchObject({
      incidentId,
      symptom: "API error rate spiking above 5%",
      status: "investigating",
    });

    // Abort the incident
    const abortResult = parseToolResult(
      await client.callTool({
        name: "bober_incident_abort",
        arguments: {
          incidentId,
          reason: "False alarm — metrics returned to normal",
          projectPath: projectRoot,
        },
      }),
    ) as { incidentId: string; status: string; abortReportPath: string };

    expect(abortResult).toMatchObject({ incidentId, status: "aborted" });
    expect(abortResult.abortReportPath).toContain("abort-report.md");

    // Verify abort-report.md exists at the reported path
    await stat(abortResult.abortReportPath); // throws if not found
  }, 30_000);
});
