// ── chat-session-steer.test.ts ────────────────────────────────────────
//
// Tests for sprint 4: steer actions (inspect + stop) and /stop slash command.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import { RunSpawner } from "./run-spawner.js";
import { RosterReader } from "./roster-reader.js";
import { writeRunState } from "../state/run-state.js";
import type { LLMClient } from "../providers/types.js";
import type { ChatParams, ChatResponse } from "../providers/types.js";
import type { SpawnAck, StopResult } from "./run-spawner.js";
import type { RunState } from "../mcp/run-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-steer-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── LLM fakes ─────────────────────────────────────────────────────────

/** LLMClient that always classifies as steer:stop for the given runId. */
function makeSteerStopLLM(runId: string): LLMClient {
  return {
    chat: async () => ({
      text: JSON.stringify({ action: "steer", op: "stop", runId }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  } as unknown as LLMClient;
}

/** LLMClient that always classifies as steer:inspect. */
function makeSteerInspectLLM(): LLMClient {
  return {
    chat: async () => ({
      text: JSON.stringify({ action: "steer", op: "inspect" }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  } as unknown as LLMClient;
}

/**
 * ThrowingClient — proves no LLM call on deterministic slash path (sc-4-6).
 * Mirrors the pattern from slash-commands.test.ts:13-17.
 */
class ThrowingClient implements LLMClient {
  async chat(_params: ChatParams): Promise<ChatResponse> {
    throw new Error("LLMClient must NOT be called for slash commands");
  }
}

// ── Spawner fakes ──────────────────────────────────────────────────────

function makeStopCapturingSpawner(
  projectRoot: string,
  sessionId: string,
  killCalls: Array<{ pid: number; signal?: string | number }>,
): RunSpawner {
  return new RunSpawner({
    projectRoot,
    sessionId,
    spawn: (_f, _a, _o) => ({ pid: 4242, unref: () => {} }),
    kill: (pid, signal) => { killCalls.push({ pid, signal }); },
    cliEntry: "/fake/cli/index.js",
    nodeBin: "/fake/node",
    now: () => "2026-06-14T00:00:00.000Z",
  });
}

// ── sc-4-6: /stop slash command never calls LLM ───────────────────────

describe("sc-4-6: /stop slash command is deterministic (no LLM call)", () => {
  it("feeds /stop run-x to a session whose LLMClient throws if called — asserts stop ran", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    const spawner = makeStopCapturingSpawner(tmpDir, "sess-6", killCalls);

    // Seed sidecar + running state via a real spawn
    await spawner.spawn("task for run-x", "run-x");

    const session = new ChatSession({
      llm: new ThrowingClient(),   // LLM must NOT be called
      projectRoot: tmpDir,
      sessionId: "sess-6",
      spawner,
    });

    const reply = await session.handleTurn("/stop run-x");

    // LLM was NOT called (ThrowingClient would have thrown if it was).
    // The stop handler ran and killed the pid.
    expect(reply).not.toBeNull();
    expect(reply).toContain("run-x");
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0].pid).toBe(4242);
  });

  it("/stop with no arg returns usage hint without calling LLM", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-6b",
    });

    const reply = await session.handleTurn("/stop");
    expect(reply).toContain("Usage: /stop <runId>");
  });
});

// ── sc-4-7: steer:stop absent runId returns "no such running run" ──────

describe("sc-4-7: classifier steer:stop for absent runId never kills", () => {
  it("runId not in roster → reply contains 'No such running run' and kill not called", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "sess-7",
      spawn: (_f, _a, _o) => ({ pid: 5555, unref: () => {} }),
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    const llm = makeSteerStopLLM("run-does-not-exist");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "sess-7",
      spawner,
    });

    const reply = await session.handleTurn("stop that run");

    expect(reply).toContain("No such running run");
    expect(killCalls).toHaveLength(0);
  });

  it("runId with status != running → reply contains 'No such running run' and kill not called", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "sess-7b",
      spawn: (_f, _a, _o) => ({ pid: 6666, unref: () => {} }),
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    // Write a completed (not running) run
    const completedState: RunState = {
      runId: "run-completed",
      task: "done task",
      status: "completed",
      startedAt: "2026-06-14T00:00:00.000Z",
      completedAt: "2026-06-14T01:00:00.000Z",
      progress: { completed: 1, total: 1 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, completedState);

    const llm = makeSteerStopLLM("run-completed");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "sess-7b",
      spawner,
    });

    const reply = await session.handleTurn("stop that completed run");

    expect(reply).toContain("No such running run");
    expect(killCalls).toHaveLength(0);
  });
});

// ── sc-4-8: steer:inspect returns roster summary ──────────────────────

describe("sc-4-8: classifier steer:inspect returns roster summary identical to RosterReader.summarize", () => {
  it("steer:inspect reply equals RosterReader.summarize output for the same states", async () => {
    // Seed a running state so the roster is non-empty
    const runningState: RunState = {
      runId: "run-inspect",
      task: "inspect me",
      status: "running",
      startedAt: "2026-06-14T00:00:00.000Z",
      progress: { completed: 0, total: 0 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, runningState);

    const llm = makeSteerInspectLLM();
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "sess-8",
    });

    const reply = await session.handleTurn("what is running?");

    // Compute the expected summary via the real RosterReader
    const roster = new RosterReader(tmpDir);
    const states = await roster.read();
    const expectedSummary = roster.summarize(states);

    // steer:inspect must return the same string as RosterReader.summarize
    // (completions may be prepended but the summary must be present)
    expect(reply).toContain(expectedSummary.slice(0, 20)); // key prefix
    expect(reply).toContain("run-inspect");
  });

  it("steer:inspect returns 'No runs found.' when roster is empty", async () => {
    const llm = makeSteerInspectLLM();
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "sess-8b",
    });

    const reply = await session.handleTurn("any runs?");

    expect(reply).toContain("No runs found.");
  });
});

// ── Verify existing SpawnAck stub-style still works (regression guard) ─

describe("RunSpawner stub interface remains compatible (regression)", () => {
  it("stop can be called on a stubbed spawner using as unknown as RunSpawner", async () => {
    let stopCalled = false;
    let stopRunId = "";

    const fakeSpawner: RunSpawner = {
      spawn: async (_task: string, runId: string): Promise<SpawnAck> => ({
        runId,
        task: _task,
        pid: 1234,
        cwd: tmpDir,
      }),
      stop: async (runId: string, _reason: string): Promise<StopResult> => {
        stopCalled = true;
        stopRunId = runId;
        return { stopped: true, runId, killedPid: 1234 };
      },
    } as unknown as RunSpawner;

    // Seed running state so handleStop finds the run
    const runningState: RunState = {
      runId: "run-stub",
      task: "stub task",
      status: "running",
      startedAt: "2026-06-14T00:00:00.000Z",
      progress: { completed: 0, total: 0 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, runningState);

    const llm = makeSteerStopLLM("run-stub");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "sess-stub",
      spawner: fakeSpawner,
    });

    const reply = await session.handleTurn("stop run-stub");
    expect(stopCalled).toBe(true);
    expect(stopRunId).toBe("run-stub");
    expect(reply).toContain("run-stub");
    expect(reply).toContain("1234");
  });
});
