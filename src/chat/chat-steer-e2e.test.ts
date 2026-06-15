// ── chat-steer-e2e.test.ts ────────────────────────────────────────────
//
// End-to-end test driving the WHOLE mid-flight HITL loop offline (sc-6-5).
// Uses real temp dirs, stubbed RunSpawner + LLMs, NO network, NO real LLM.
//
// Sequence:
//   1. /careful on  → verify sidecar persisted
//   2. Spawn with careful=true → assert --approve-gates in captured args
//   3. Inject post-plan pending marker → turn surfaces input-required notice
//      + RunState.status === "input-required"
//   4. /tell → guidance.jsonl has the entry
//   5. /approve post-plan → .approved.json written, RunState pending cleared
//   6. Inject post-sprint pending → /pause → paused.json + RunState paused
//   7. /resume → paused cleared + RunState back to running
//   8. injectCompletion → turn asserts cleanup ran (stale markers gone, RunState clear)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, access, appendFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import { RunSpawner } from "./run-spawner.js";
import { CarefulSidecar } from "./careful-sidecar.js";
import { writeRunState, readRunState } from "../state/run-state.js";
import { isPaused } from "../state/pause.js";
import { pendingExists } from "../state/approval-state.js";
import type { PendingMarker } from "../state/approval-state.js";
import type { LLMClient } from "../providers/types.js";
import type { ChatParams, ChatResponse } from "../providers/types.js";
import type { RunState } from "../mcp/run-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-e2e-steer-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── LLM fakes ─────────────────────────────────────────────────────────

/** ThrowingClient — proves slash commands never call LLM. */
class ThrowingClient implements LLMClient {
  async chat(_params: ChatParams): Promise<ChatResponse> {
    throw new Error("LLMClient must NOT be called for slash commands");
  }
}

/** LLM that always classifies as spawn with the given task. */
function makeSpawnClassifierLLM(task: string): LLMClient {
  return {
    chat: async () => ({
      text: JSON.stringify({ action: "spawn", task }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  } as unknown as LLMClient;
}

/** LLM that classifies as "answer" and returns fixed reply. */
function makeAnswerLLM(reply: string): LLMClient {
  let callCount = 0;
  return {
    chat: async () => {
      callCount++;
      if (callCount === 1) {
        return {
          text: JSON.stringify({ action: "answer" }),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      }
      return {
        text: reply,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  } as unknown as LLMClient;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Build a synthetic PendingMarker. */
function makeMarker(
  o?: Partial<{
    checkpointId: string;
    runId: string;
    prompt: string;
    requestedAt: string;
  }>,
): PendingMarker {
  const now = new Date().toISOString();
  return {
    checkpointId: "post-plan",
    artifact: { type: "research-doc" },
    prompt: "Approve this action",
    requestedAt: now,
    timeoutAt: now,
    ...o,
  };
}

/** Write a .pending.json file directly to the approvals dir. */
async function injectPending(root: string, m: PendingMarker): Promise<void> {
  const dir = join(root, ".bober", "approvals");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${m.checkpointId}.pending.json`),
    JSON.stringify(m, null, 2),
    "utf-8",
  );
}

/** Write a running RunState for the given runId. */
async function injectRunningRun(root: string, runId: string): Promise<RunState> {
  const state: RunState = {
    runId,
    task: `Task for ${runId}`,
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { completed: 0, total: 1 },
    projectRoot: root,
  };
  await writeRunState(root, state);
  return state;
}

/** Write a pipeline-complete line + .completed.json marker so CompletionTailer returns the event. */
async function injectCompletion(
  projectRoot: string,
  runId: string,
  phase: "complete" | "failed" = "complete",
): Promise<void> {
  const boberDir = join(projectRoot, ".bober");
  await mkdir(boberDir, { recursive: true });
  const histPath = join(boberDir, "history.jsonl");
  const runsDir = join(boberDir, "runs");
  await mkdir(runsDir, { recursive: true });

  const histLine =
    JSON.stringify({
      timestamp: "2026-06-15T10:00:00.000Z",
      event: "pipeline-complete",
      phase,
      details: { completed: 1, failed: 0, durationMs: 5000 },
    }) + "\n";
  await appendFile(histPath, histLine, "utf-8");

  const markerPath = join(runsDir, `${runId}.completed.json`);
  await writeFile(
    markerPath,
    JSON.stringify({ runId, completedAt: "2026-06-15T10:00:00.000Z" }, null, 2) + "\n",
    "utf-8",
  );
}

/** Calls-capturing spawner — records each spawn call without launching a real process. */
function makeCapturingSpawner(
  projectRoot: string,
  sessionId: string,
  calls: Array<{ file: string; args: string[]; options: unknown }>,
): RunSpawner {
  return new RunSpawner({
    projectRoot,
    sessionId,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { pid: 4242, unref: () => {} };
    },
    kill: () => {},
    cliEntry: "/fake/cli/index.js",
    nodeBin: "/fake/node",
    now: () => "2026-06-15T00:00:00.000Z",
  });
}

// ── E2E test ──────────────────────────────────────────────────────────

describe("sc-6-5: full-loop e2e — careful→spawn→approve→pause→resume→completion→cleanup", () => {
  const SESSION_ID = "e2e-session";
  const RUN_ID = "run-1718323200000";

  it("drives the complete HITL steer loop with disk assertions at each step", async () => {
    const spawnCalls: Array<{ file: string; args: string[]; options: unknown }> = [];
    const spawner = makeCapturingSpawner(tmpDir, SESSION_ID, spawnCalls);

    // ── Step 1: /careful on ───────────────────────────────────────────────
    const carefulSession = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200000,
    });

    const carefulReply = await carefulSession.handleTurn("/careful on");
    expect(carefulReply).toContain("ON");

    const sidecar = new CarefulSidecar(tmpDir, SESSION_ID);
    expect(await sidecar.isCareful()).toBe(true);

    // ── Step 2: Spawn with careful=true → assert --approve-gates in args ─
    const spawnSession = new ChatSession({
      llm: makeSpawnClassifierLLM("build the feature"),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200000,
    });

    const spawnReply = await spawnSession.handleTurn("Please build the feature");
    expect(spawnReply).toContain(RUN_ID);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.args).toContain("--approve-gates");
    expect(spawnCalls[0]!.args).toContain("post-research,post-plan,post-sprint");

    // Ensure a running RunState exists for the spawned run
    await injectRunningRun(tmpDir, RUN_ID);

    // ── Step 3: Simulate child reaching post-plan gate ────────────────────
    const postPlanMarker = makeMarker({
      checkpointId: "post-plan",
      runId: RUN_ID,
      prompt: "Research phase complete, proceed to plan?",
    });
    await injectPending(tmpDir, postPlanMarker);

    const surfaceSession = new ChatSession({
      llm: makeAnswerLLM("Working on it."),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200001,
    });

    const surfaceReply = await surfaceSession.handleTurn("Any updates?");
    expect(surfaceReply).toContain(RUN_ID);
    expect(surfaceReply).toContain("post-plan");

    // RunState should be input-required with pending fields
    const stateAfterSurface = await readRunState(tmpDir, RUN_ID);
    expect(stateAfterSurface?.status).toBe("input-required");
    expect(stateAfterSurface?.pendingCheckpointId).toBe("post-plan");
    expect(stateAfterSurface?.pendingPrompt).toBeTruthy();

    // ── Step 4: /tell → guidance.jsonl has entry ──────────────────────────
    const tellSession = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200002,
    });

    const tellReply = await tellSession.handleTurn(`/tell ${RUN_ID} prefer Zod schemas`);
    expect(tellReply).toContain("Queued");
    expect(tellReply).toContain(RUN_ID);

    const guidancePath = join(tmpDir, ".bober", "runs", RUN_ID, "guidance.jsonl");
    const guidanceRaw = await readFile(guidancePath, "utf-8");
    const guidanceEntry = JSON.parse(guidanceRaw.trim()) as { text: string; consumed: boolean };
    expect(guidanceEntry.text).toBe("prefer Zod schemas");
    expect(guidanceEntry.consumed).toBe(false);

    // ── Step 5: /approve post-plan → .approved.json written, pending cleared ─
    const approveSession = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200003,
    });

    const approveReply = await approveSession.handleTurn("/approve post-plan");
    expect(approveReply).toContain("Approved");
    expect(approveReply).toContain("post-plan");

    // .approved.json written
    const approvedPath = join(tmpDir, ".bober", "approvals", "post-plan.approved.json");
    const approvedRaw = await readFile(approvedPath, "utf-8");
    const approvedJson = JSON.parse(approvedRaw) as { approvedAt: string };
    expect(typeof approvedJson.approvedAt).toBe("string");

    // RunState pending fields cleared, status back to running
    // Note: .pending.json is NOT deleted by /approve — it is cleaned up on run completion.
    // The run process reads .approved.json to resume and the completion cleanup deletes the marker.
    const stateAfterApprove = await readRunState(tmpDir, RUN_ID);
    expect(stateAfterApprove?.status).toBe("running");
    expect(stateAfterApprove?.pendingCheckpointId).toBeUndefined();
    expect(stateAfterApprove?.pendingPrompt).toBeUndefined();
    expect(stateAfterApprove?.pendingSince).toBeUndefined();

    // ── Step 6: /pause → paused.json + RunState paused ───────────────────
    // Note: inject the post-sprint marker AFTER pausing (to avoid approval prelude
    // converting RunState to input-required before /pause can act on the "running" state).
    const postSprintMarker = makeMarker({
      checkpointId: "post-sprint",
      runId: RUN_ID,
      prompt: "Sprint complete, approve commit?",
    });

    // Ensure run is running (approve already set it to running)
    const runningState = await readRunState(tmpDir, RUN_ID);
    if (runningState?.status !== "running") {
      await injectRunningRun(tmpDir, RUN_ID);
    }

    const pauseSession = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200004,
    });

    const pauseReply = await pauseSession.handleTurn(`/pause ${RUN_ID}`);
    expect(pauseReply).toContain("Paused");
    expect(pauseReply).toContain(RUN_ID);
    expect(pauseReply).toContain("stays alive");

    // paused.json written
    expect(await isPaused(tmpDir, RUN_ID)).toBe(true);

    // RunState flipped to paused with pausedAt
    const stateAfterPause = await readRunState(tmpDir, RUN_ID);
    expect(stateAfterPause?.status).toBe("paused");
    expect(stateAfterPause?.pausedAt).toBeTruthy();

    // ── Step 7: /resume → paused cleared, RunState back to running ─────────
    const resumeSession = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200005,
    });

    const resumeReply = await resumeSession.handleTurn(`/resume ${RUN_ID}`);
    expect(resumeReply).toContain("Resumed");
    expect(resumeReply).toContain(RUN_ID);

    // paused.json gone
    expect(await isPaused(tmpDir, RUN_ID)).toBe(false);

    // RunState back to running, pausedAt gone
    const stateAfterResume = await readRunState(tmpDir, RUN_ID);
    expect(stateAfterResume?.status).toBe("running");
    expect(stateAfterResume?.pausedAt).toBeUndefined();

    // ── Step 8: Completion → cleanup runs (stale markers + RunState cleared) ─
    // Inject guidance again (simulating /tell after resume)
    await appendFile(guidancePath, JSON.stringify({ ts: new Date().toISOString(), text: "final guidance", consumed: false }) + "\n", "utf-8");

    // Re-inject the post-sprint pending marker (simulate it lingered)
    await injectPending(tmpDir, postSprintMarker);

    // Verify marker is present before completion
    expect(await pendingExists(tmpDir, "post-sprint")).toBe(true);

    // Inject a completion event (history line + .completed.json)
    await injectCompletion(tmpDir, RUN_ID, "complete");

    // Drive a turn — the completion poll prelude fires cleanup
    const completionSession = new ChatSession({
      llm: makeAnswerLLM("All done."),
      projectRoot: tmpDir,
      sessionId: SESSION_ID,
      spawner,
      now: () => 1718323200006,
    });

    const completionReply = await completionSession.handleTurn("Are we done?");
    // Completion notice should be woven into reply
    expect(completionReply).toContain(RUN_ID);
    expect(completionReply).toContain("finished");

    // Cleanup: stale post-sprint.pending.json gone
    expect(await pendingExists(tmpDir, "post-sprint")).toBe(false);

    // Cleanup: guidance.jsonl gone
    let guidanceStillExists = false;
    try {
      await access(guidancePath, constants.R_OK);
      guidanceStillExists = true;
    } catch {
      // expected — cleaned up
    }
    expect(guidanceStillExists).toBe(false);

    // Cleanup: paused.json still gone (was cleared by /resume)
    expect(await isPaused(tmpDir, RUN_ID)).toBe(false);

    // Cleanup: RunState pending/paused fields cleared (terminal status preserved)
    const stateAfterCleanup = await readRunState(tmpDir, RUN_ID);
    expect(stateAfterCleanup?.pendingCheckpointId).toBeUndefined();
    expect(stateAfterCleanup?.pendingPrompt).toBeUndefined();
    expect(stateAfterCleanup?.pendingSince).toBeUndefined();
    expect(stateAfterCleanup?.pausedAt).toBeUndefined();
  });
});
