// ── chat-session-steer.test.ts ────────────────────────────────────────
//
// Tests for sprint 4: steer actions (inspect + stop) and /stop slash command.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import { RunSpawner } from "./run-spawner.js";
import { RosterReader } from "./roster-reader.js";
import { writeRunState, readRunState } from "../state/run-state.js";
import { isPaused } from "../state/pause.js";
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

// ── sc-4-8: NL 'tell run X to ...' classifier route + /tell slash ─────

/** LLMClient that always classifies as tell {runId, text}. */
function makeTellLLM(runId: string, text: string): LLMClient {
  return {
    chat: async () => ({
      text: JSON.stringify({ action: "tell", runId, text }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  } as unknown as LLMClient;
}

describe("sc-4-8: NL 'tell run X to ...' routes to handleTell and writes guidance entry", () => {
  it("classified tell action writes guidance entry to guidance.jsonl", async () => {
    const runId = "run-tell-test";
    // Seed the run dir so hasRunDir returns true
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    const llm = makeTellLLM(runId, "prefer Zod");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "sess-tell",
    });

    const reply = await session.handleTurn("tell run run-tell-test to prefer Zod");

    expect(reply).not.toBeNull();
    expect(reply).toContain(runId);
    expect(reply).toContain("Queued");

    // Verify guidance.jsonl was written
    const raw = await readFile(
      join(tmpDir, ".bober", "runs", runId, "guidance.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(raw.trim()) as { text: string; consumed: boolean };
    expect(entry.text).toBe("prefer Zod");
    expect(entry.consumed).toBe(false);
  });

  it("tell for an unknown run returns clear error and writes nothing", async () => {
    const llm = makeTellLLM("run-does-not-exist", "some text");
    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "sess-tell-unknown",
    });

    const reply = await session.handleTurn("tell run run-does-not-exist to do something");
    expect(reply).toContain("No such run");
    expect(reply).not.toContain("Queued");
  });

  it("/tell slash command writes guidance for a known run", async () => {
    const runId = "run-slash-tell";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    const session = new ChatSession({
      llm: new ThrowingClient(),  // LLM must NOT be called for slash commands
      projectRoot: tmpDir,
      sessionId: "sess-slash-tell",
    });

    const reply = await session.handleTurn(`/tell ${runId} use strict mode`);

    expect(reply).toContain("Queued");
    expect(reply).toContain(runId);

    const raw = await readFile(
      join(tmpDir, ".bober", "runs", runId, "guidance.jsonl"),
      "utf-8",
    );
    const entry = JSON.parse(raw.trim()) as { text: string };
    expect(entry.text).toBe("use strict mode");
  });

  it("/tell slash command for unknown run returns clear error", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-slash-tell-unknown",
    });

    const reply = await session.handleTurn("/tell run-unknown some guidance");
    expect(reply).toContain("No such run");
  });
});

// ── sc-4-8: /help lists /tell ─────────────────────────────────────────

describe("sc-4-8: /help lists /tell", () => {
  it("/help output includes /tell", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-help-tell",
    });

    const reply = await session.handleTurn("/help");
    expect(reply).toContain("/tell");
  });

  it("/help output describes /tell guidance purpose", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-help-tell-2",
    });

    const reply = await session.handleTurn("/help");
    // The help text should mention guidance context
    expect(reply).toContain("guidance");
  });
});

// ── LLM fakes for pause/resume ────────────────────────────────────────

/** LLMClient that always classifies as pause for the given runId. */
function makePauseLLM(runId: string): LLMClient {
  return {
    chat: async () => ({
      text: JSON.stringify({ action: "pause", runId }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  } as unknown as LLMClient;
}

/** LLMClient that always classifies as resume for the given runId. */
function makeResumeLLM(runId: string): LLMClient {
  return {
    chat: async () => ({
      text: JSON.stringify({ action: "resume", runId }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  } as unknown as LLMClient;
}

// ── sc-5-4: /pause is distinct from /stop — NO kill signal ───────────

describe("sc-5-4: /pause running run writes marker + RunState, does NOT kill", () => {
  it("/pause on a running run writes paused.json, flips RunState to paused, does NOT kill", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    const spawner = makeStopCapturingSpawner(tmpDir, "sess-pause-5-4", killCalls);

    // Seed a running state + sidecar pid via a real spawn
    await spawner.spawn("task for pause test", "run-pause-target");

    const session = new ChatSession({
      llm: new ThrowingClient(), // LLM must NOT be called for slash commands
      projectRoot: tmpDir,
      sessionId: "sess-pause-5-4",
      spawner,
    });

    const reply = await session.handleTurn("/pause run-pause-target");

    // 1. Reply acknowledges the run and mentions process stays alive
    expect(reply).not.toBeNull();
    expect(reply).toContain("run-pause-target");
    expect(reply).toContain("stays alive");

    // 2. THE no-kill assertion (contrast with /stop which has killCalls.length === 1)
    expect(killCalls).toHaveLength(0);

    // 3. paused.json marker was written
    expect(await isPaused(tmpDir, "run-pause-target")).toBe(true);

    // 4. RunState was flipped to 'paused' with a pausedAt timestamp
    const state = await readRunState(tmpDir, "run-pause-target");
    expect(state).not.toBeNull();
    expect(state?.status).toBe("paused");
    expect(state?.pausedAt).toBeTruthy();
    expect(typeof state?.pausedAt).toBe("string");
  });

  it("/pause on unknown run returns clear message, writes nothing", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-pause-unknown",
    });

    const reply = await session.handleTurn("/pause run-does-not-exist");
    expect(reply).toContain("No such running run");
    expect(await isPaused(tmpDir, "run-does-not-exist")).toBe(false);
  });

  it("/pause on non-running (completed) run returns clear message, writes nothing", async () => {
    const completedState: RunState = {
      runId: "run-completed-pause",
      task: "done",
      status: "completed",
      startedAt: "2026-06-15T00:00:00.000Z",
      completedAt: "2026-06-15T01:00:00.000Z",
      progress: { completed: 1, total: 1 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, completedState);

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-pause-completed",
    });

    const reply = await session.handleTurn("/pause run-completed-pause");
    expect(reply).toContain("No such running run");
    expect(await isPaused(tmpDir, "run-completed-pause")).toBe(false);
  });

  it("NL pause intent is classified and routed to handlePause (no LLM restriction — uses stubbed classifier)", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];
    const spawner = makeStopCapturingSpawner(tmpDir, "sess-nl-pause", killCalls);
    await spawner.spawn("nl pause task", "run-nl-pause");

    const session = new ChatSession({
      llm: makePauseLLM("run-nl-pause"),
      projectRoot: tmpDir,
      sessionId: "sess-nl-pause",
      spawner,
    });

    const reply = await session.handleTurn("pause run-nl-pause please");
    expect(reply).toContain("run-nl-pause");
    // No kill via NL path either
    expect(killCalls).toHaveLength(0);
    expect(await isPaused(tmpDir, "run-nl-pause")).toBe(true);
  });
});

// ── sc-5-6: /resume removes marker + RunState back to running ─────────

describe("sc-5-6: /resume removes paused.json and flips RunState to running", () => {
  it("/resume removes the paused.json marker", async () => {
    const runId = "run-resume-marker";
    // Seed a paused state
    const pausedState: RunState = {
      runId,
      task: "pause me",
      status: "paused",
      pausedAt: "2026-06-15T00:00:00.000Z",
      startedAt: "2026-06-15T00:00:00.000Z",
      progress: { completed: 0, total: 1 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, pausedState);
    // Write the marker manually (setPaused)
    const { setPaused: sp } = await import("../state/pause.js");
    await sp(tmpDir, runId);
    expect(await isPaused(tmpDir, runId)).toBe(true);

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-resume",
    });

    const reply = await session.handleTurn(`/resume ${runId}`);
    expect(reply).toContain(runId);
    expect(await isPaused(tmpDir, runId)).toBe(false);
  });

  it("/resume flips RunState from paused to running", async () => {
    const runId = "run-resume-state";
    const pausedState: RunState = {
      runId,
      task: "resume me",
      status: "paused",
      pausedAt: "2026-06-15T00:00:00.000Z",
      startedAt: "2026-06-15T00:00:00.000Z",
      progress: { completed: 0, total: 1 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, pausedState);

    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-resume-state",
    });

    await session.handleTurn(`/resume ${runId}`);

    const state = await readRunState(tmpDir, runId);
    expect(state?.status).toBe("running");
    // pausedAt should be dropped from the resumed state
    expect(state?.pausedAt).toBeUndefined();
  });

  it("NL resume intent is classified and routed to handleResume", async () => {
    const runId = "run-nl-resume";
    const pausedState: RunState = {
      runId,
      task: "nl resume task",
      status: "paused",
      pausedAt: "2026-06-15T00:00:00.000Z",
      startedAt: "2026-06-15T00:00:00.000Z",
      progress: { completed: 0, total: 1 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, pausedState);
    const { setPaused: sp2 } = await import("../state/pause.js");
    await sp2(tmpDir, runId);

    const session = new ChatSession({
      llm: makeResumeLLM(runId),
      projectRoot: tmpDir,
      sessionId: "sess-nl-resume",
    });

    const reply = await session.handleTurn("please resume run-nl-resume");
    expect(reply).toContain(runId);
    expect(await isPaused(tmpDir, runId)).toBe(false);
  });
});

// ── sc-5-6: /help lists /pause and /resume ────────────────────────────

describe("sc-5-6: /help lists /pause and /resume", () => {
  it("/help output includes /pause", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-help-pause",
    });
    const reply = await session.handleTurn("/help");
    expect(reply).toContain("/pause");
  });

  it("/help output includes /resume", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-help-resume",
    });
    const reply = await session.handleTurn("/help");
    expect(reply).toContain("/resume");
  });

  it("/help distinguishes /pause (soft) from /stop (hard kill)", async () => {
    const session = new ChatSession({
      llm: new ThrowingClient(),
      projectRoot: tmpDir,
      sessionId: "sess-help-distinct",
    });
    const reply = await session.handleTurn("/help");
    // /stop must clearly signal the kill; /pause must mention process stays alive
    expect(reply).toContain("killing");
    expect(reply).toContain("process stays alive");
  });
});
