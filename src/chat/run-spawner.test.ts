import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunSpawner } from "./run-spawner.js";
import { PidSidecar } from "./pid-sidecar.js";
import { readRunState } from "../state/run-state.js";

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
