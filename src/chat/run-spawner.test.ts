import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunSpawner } from "./run-spawner.js";
import { PidSidecar } from "./pid-sidecar.js";
import { readRunState, writeRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-spawner-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeFakeSpawn(pid = 4242): {
  spawn: (f: string, a: string[], o: unknown) => { pid: number; unref: () => void };
  calls: Array<{ file: string; args: string[]; options: unknown }>;
  unrefCalled: boolean;
} {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
  let unrefCalled = false;

  const spawn = (file: string, args: string[], options: unknown) => {
    calls.push({ file, args, options });
    return { pid, unref: () => { unrefCalled = true; } };
  };

  return { spawn, calls, get unrefCalled() { return unrefCalled; } };
}

describe("RunSpawner", () => {
  it("writes roster state.json BEFORE launching and returns SpawnAck synchronously (sc-2-6)", async () => {
    const { spawn, calls } = makeFakeSpawn(4242);

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s1",
      spawn,
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    const ack = await spawner.spawn("build X", "test-run-123");

    // state.json must exist with status 'running' immediately
    const state = await readRunState(tmpDir, "test-run-123");
    expect(state?.status).toBe("running");
    expect(state?.runId).toBe("test-run-123");
    expect(state?.task).toBe("build X");
    expect(state?.projectRoot).toBe(tmpDir);

    // SpawnAck must be returned with the correct runId
    expect(ack.runId).toBe("test-run-123");
    expect(ack.task).toBe("build X");
    expect(ack.pid).toBe(4242);
    expect(ack.cwd).toBe(tmpDir);
    expect(ack.spawnError).toBeUndefined();

    // The fake spawn was called exactly once
    expect(calls).toHaveLength(1);
  });

  it("passes correct args to spawn fn — cwd=projectRoot, detached:true (sc-2-9)", async () => {
    const { calls } = makeFakeSpawn(4242);
    let unrefCalled = false;

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s1",
      spawn: (file, args, options) => {
        calls.push({ file, args, options });
        return { pid: 4242, unref: () => { unrefCalled = true; } };
      },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    await spawner.spawn("build X", "test-run-123");

    expect(calls[0].file).toBe("/fake/node");
    expect(calls[0].args).toEqual(["/fake/cli/index.js", "run", "build X", "--run-id", "test-run-123"]);
    expect(calls[0].options).toMatchObject({ cwd: tmpDir, detached: true, stdio: "ignore" });
    expect(unrefCalled).toBe(true);
  });

  it("persists pid sidecar across instances (sc-2-7)", async () => {
    const { spawn } = makeFakeSpawn(4242);

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s1",
      spawn,
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    await spawner.spawn("build X", "test-run-123");

    // A fresh PidSidecar instance must read the entry from disk
    const fresh = new PidSidecar(tmpDir, "s1");
    const all = await fresh.readAll();
    expect(all["test-run-123"]?.pid).toBe(4242);
    expect(all["test-run-123"]?.task).toBe("build X");
    expect(all["test-run-123"]?.spawnedAt).toBe("2026-06-14T00:00:00.000Z");
  });

  it("returns spawnError in ack when the spawn fn throws", async () => {
    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s1",
      spawn: () => { throw new Error("ENOENT: no such file"); },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    const ack = await spawner.spawn("build X", "fail-run");
    expect(ack.spawnError).toBe("ENOENT: no such file");
    expect(ack.pid).toBeUndefined();
  });
});

// ── RunSpawner.stop tests ──────────────────────────────────────────────

describe("RunSpawner.stop", () => {
  it("sc-4-4: resolves pid from sidecar, calls kill with it, flips state to aborted", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s1",
      spawn: (_f, _a, _o) => ({ pid: 4242, unref: () => {} }),
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    // spawn seeds sidecar pid 4242 + running state
    await spawner.spawn("build X", "run-x");
    const result = await spawner.stop("run-x", "test");

    expect(killCalls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect((await readRunState(tmpDir, "run-x"))?.status).toBe("aborted");
    expect(result.killedPid).toBe(4242);
    expect(result.stopped).toBe(true);
  });

  it("sc-4-5: no sidecar entry → kill NOT called, state flipped to aborted, fallbackFlagOnly:true", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s2",
      spawn: (_f, _a, _o) => ({ pid: 9999, unref: () => {} }),
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    // Write a running state.json but NO sidecar entry (simulate crash or missing pid)
    const runningState: RunState = {
      runId: "run-no-pid",
      task: "some task",
      status: "running",
      startedAt: "2026-06-14T00:00:00.000Z",
      progress: { completed: 0, total: 0 },
      projectRoot: tmpDir,
    };
    await writeRunState(tmpDir, runningState);

    // sidecar is empty — no record was added
    const result = await spawner.stop("run-no-pid", "fallback test");

    expect(killCalls).toHaveLength(0);
    expect((await readRunState(tmpDir, "run-no-pid"))?.status).toBe("aborted");
    expect(result.stopped).toBe(true);
    expect(result.fallbackFlagOnly).toBe(true);
    expect(result.killedPid).toBeUndefined();
  });

  it("sc-4-9: unknown runId (no sidecar, no disk state) → kill never called, stopped:false", async () => {
    const killCalls: Array<{ pid: number; signal?: string | number }> = [];

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s3",
      spawn: (_f, _a, _o) => ({ pid: 1111, unref: () => {} }),
      kill: (pid, signal) => { killCalls.push({ pid, signal }); },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    // No spawn call — nothing in sidecar or disk
    const result = await spawner.stop("run-does-not-exist", "stale");

    expect(killCalls).toHaveLength(0);
    expect(result.stopped).toBe(false);
    expect(result.killedPid).toBeUndefined();
  });

  it("tolerates ESRCH (already-dead pid) without throwing", async () => {
    let killCalled = false;

    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "s4",
      spawn: (_f, _a, _o) => ({ pid: 7777, unref: () => {} }),
      kill: (_pid, _signal) => {
        killCalled = true;
        // Simulate ESRCH — process already gone
        const err = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        throw err;
      },
      cliEntry: "/fake/cli/index.js",
      nodeBin: "/fake/node",
      now: () => "2026-06-14T00:00:00.000Z",
    });

    await spawner.spawn("build Y", "run-esrch");
    // Should not throw even though kill throws ESRCH
    const result = await spawner.stop("run-esrch", "ESRCH test");

    expect(killCalled).toBe(true);
    // State should still be flipped to aborted
    expect((await readRunState(tmpDir, "run-esrch"))?.status).toBe("aborted");
    expect(result.stopped).toBe(true);
  });
});
