import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChatSession } from "./chat-session.js";
import { RunSpawner } from "./run-spawner.js";
import { RosterReader } from "./roster-reader.js";
import type { LLMClient } from "../providers/types.js";
import type { SpawnAck } from "./run-spawner.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-session-spawn-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Minimal LLMClient fake that always classifies as spawn with task "build X". */
function makeSpawnClassifierLLM(task: string): LLMClient {
  return {
    chat: async () => ({
      text: JSON.stringify({ action: "spawn", task }),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
  } as unknown as LLMClient;
}

/** A RunSpawner that records the spawn call and returns immediately (no real process). */
function makeFakeSpawner(projectRoot: string, sessionId: string): RunSpawner {
  return new RunSpawner({
    projectRoot,
    sessionId,
    spawn: (_file, _args, _opts) => ({ pid: 9999, unref: () => {} }),
    cliEntry: "/fake/cli/index.js",
    nodeBin: "/fake/node",
    now: () => "2026-06-14T00:00:00.000Z",
  });
}

describe("ChatSession spawn branch (sc-2-8)", () => {
  it("routes spawn action to RunSpawner and reply contains runId", async () => {
    const llm = makeSpawnClassifierLLM("build something");
    const fakeSpawner = makeFakeSpawner(tmpDir, "test-session");

    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-session",
      spawner: fakeSpawner,
      now: () => 1718323200000, // deterministic timestamp → run-1718323200000
    });

    const reply = await session.handleTurn("Please build something for me");

    expect(reply).not.toBeNull();
    expect(reply).toContain("run-1718323200000");
    expect(reply).toContain("build something");
  });

  it("roster shows run as running after spawn (sc-2-8)", async () => {
    const llm = makeSpawnClassifierLLM("build a feature");
    const fakeSpawner = makeFakeSpawner(tmpDir, "test-session-2");

    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "test-session-2",
      spawner: fakeSpawner,
      now: () => 1718323200000,
    });

    await session.handleTurn("build a feature please");

    const roster = new RosterReader(tmpDir);
    const states = await roster.read();
    const run = states.find((s) => s.runId === "run-1718323200000");
    expect(run).toBeDefined();
    expect(run?.status).toBe("running");
  });

  it("reply contains spawnError when spawn fails", async () => {
    const llm = makeSpawnClassifierLLM("bad task");
    const failingSpawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "fail-session",
      spawn: () => { throw new Error("ENOENT"); },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "fail-session",
      spawner: failingSpawner,
      now: () => 1718323200000,
    });

    const reply = await session.handleTurn("do bad thing");
    expect(reply).toContain("Failed to launch run");
    expect(reply).toContain("run-1718323200000");
  });
});

describe("ChatSession spawn reply assertion for SpawnAck", () => {
  it("reply says Use /runs to track when spawn succeeds", async () => {
    const llm = makeSpawnClassifierLLM("deploy app");
    const fakeSpawner: RunSpawner = {
      spawn: async (_task: string, runId: string): Promise<SpawnAck> => ({
        runId,
        task: _task,
        pid: 1234,
        cwd: tmpDir,
      }),
    } as unknown as RunSpawner;

    const session = new ChatSession({
      llm,
      projectRoot: tmpDir,
      sessionId: "s3",
      spawner: fakeSpawner,
      now: () => 5000,
    });

    const reply = await session.handleTurn("please deploy the app");
    expect(reply).toContain("run-5000");
    expect(reply).toContain("Use /runs");
  });
});
