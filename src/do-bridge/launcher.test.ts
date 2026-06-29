import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunSpawner } from "../chat/run-spawner.js";
import { RunSpawnerLauncher } from "./launcher.js";
import type { PromotionPlan } from "./types.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";
const PLAN: PromotionPlan = { kind: "bober-run", task: "fix the CI build" };

// ── Fake spawn helper ─────────────────────────────────────────────────

function makeFakeSpawn(pid = 4242) {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [];
  const spawn = (file: string, args: string[], options: unknown) => {
    calls.push({ file, args, options });
    return { pid, unref: () => {} };
  };
  return { spawn, calls };
}

// ── RunSpawnerLauncher tests ──────────────────────────────────────────

describe("RunSpawnerLauncher", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("calls spawn exactly once with plan.task embedded in args", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-launcher-"));
    const { spawn, calls } = makeFakeSpawn(4242);
    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "do-abc123",
      spawn,
      cliEntry: "/fake/cli.js",
      nodeBin: "/fake/node",
      now: () => T,
    });

    const launcher = new RunSpawnerLauncher({
      projectRoot: tmpDir,
      findingId: "abc123",
      now: () => T,
      spawner,
    });

    await launcher.launch(PLAN);

    expect(calls).toHaveLength(1);
    // plan.task appears in spawn args (after the cli entry + "run")
    expect(calls[0]!.args).toContain(PLAN.task);
  });

  it("returns a runId with the findingId embedded", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-launcher-"));
    const { spawn } = makeFakeSpawn();
    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "do-myid",
      spawn,
      cliEntry: "/fake/cli.js",
      nodeBin: "/fake/node",
      now: () => T,
    });

    const launcher = new RunSpawnerLauncher({
      projectRoot: tmpDir,
      findingId: "myid",
      now: () => T,
      spawner,
    });

    const { runId } = await launcher.launch(PLAN);

    expect(runId).toBe(`do-myid-${T}`);
  });

  it("returns the pid from the spawn ack", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-launcher-"));
    const { spawn } = makeFakeSpawn(9999);
    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "do-pidtest",
      spawn,
      cliEntry: "/fake/cli.js",
      nodeBin: "/fake/node",
      now: () => T,
    });

    const launcher = new RunSpawnerLauncher({
      projectRoot: tmpDir,
      findingId: "pidtest",
      now: () => T,
      spawner,
    });

    const result = await launcher.launch(PLAN);

    expect(result.pid).toBe(9999);
  });

  it("never spawns a real process (spawn fn is fully injected)", async () => {
    // This test is a guard: if the fake spawn fn was NOT injected,
    // a real execa call would attempt to start a process and fail in CI.
    tmpDir = await mkdtemp(join(tmpdir(), "bober-launcher-pid-"));
    const { spawn, calls } = makeFakeSpawn(1234);
    const spawner = new RunSpawner({
      projectRoot: tmpDir,
      sessionId: "do-noreal",
      spawn,
      cliEntry: "/fake/cli.js",
      nodeBin: "/fake/node",
      now: () => T,
    });

    const launcher = new RunSpawnerLauncher({
      projectRoot: tmpDir,
      findingId: "noreal",
      now: () => T,
      spawner,
    });

    await launcher.launch(PLAN);

    // The fake records calls — a real spawn would not appear here
    expect(calls).toHaveLength(1);
    // nodeBin is our fake path, not a real executable
    expect(calls[0]!.file).toBe("/fake/node");
  });
});
