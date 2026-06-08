import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutcomeAggregator } from "./aggregator.js";
import { writeRunState } from "../state/run-state.js";
import type { RunState } from "../mcp/run-manager.js";
import type { ChildExecution } from "./types.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-fleet-agg-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeState(o?: Partial<RunState>): RunState {
  return {
    runId: "r1",
    task: "t",
    status: "running",
    startedAt: new Date().toISOString(),
    progress: { completed: 0, total: 0 },
    projectRoot: tmpDir,
    ...o,
  };
}

function makeExecution(overrides?: {
  folder?: string;
  absPath?: string;
  scaffoldError?: string;
  exitCode?: number | null;
}): ChildExecution {
  const folder = overrides?.folder ?? "child1";
  const absPath = overrides?.absPath ?? tmpDir;
  const scaffoldError = overrides?.scaffoldError;
  const exitCode = overrides !== undefined && "exitCode" in overrides ? overrides.exitCode : 0;

  return {
    folder,
    scaffold: {
      folder,
      absPath,
      configWritten: !scaffoldError,
      gitInitialized: !scaffoldError,
      ...(scaffoldError !== undefined ? { error: scaffoldError } : {}),
    },
    spawn: scaffoldError
      ? undefined
      : {
          cwd: absPath,
          exitCode,
          stdout: "",
          stderr: "",
        },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("OutcomeAggregator", () => {
  it("disk-primary: returns newest RunState by startedAt with source 'disk' (sc-3-7)", async () => {
    const older = makeState({
      runId: "run-old",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = makeState({
      runId: "run-new",
      status: "failed",
      startedAt: "2026-06-09T12:00:00.000Z",
    });

    await writeRunState(tmpDir, older);
    await writeRunState(tmpDir, newer);

    const agg = new OutcomeAggregator();
    const execution = makeExecution({ absPath: tmpDir });
    const outcome = await agg.aggregate(execution);

    expect(outcome.source).toBe("disk");
    expect(outcome.runId).toBe("run-new");
    expect(outcome.status).toBe("failed");
    expect(outcome.runState).toBeDefined();
    expect(outcome.runState?.runId).toBe("run-new");
  });

  it("disk-primary: maps 'completed' RunState status to 'completed' (sc-3-7)", async () => {
    await writeRunState(tmpDir, makeState({ runId: "r-completed", status: "completed", startedAt: "2026-06-01T00:00:00.000Z" }));

    const agg = new OutcomeAggregator();
    const outcome = await agg.aggregate(makeExecution({ absPath: tmpDir }));

    expect(outcome.status).toBe("completed");
    expect(outcome.source).toBe("disk");
  });

  it("disk-primary: maps 'aborted' RunState status to 'failed' (sc-3-7)", async () => {
    await writeRunState(tmpDir, makeState({ runId: "r-aborted", status: "aborted", startedAt: "2026-06-01T00:00:00.000Z" }));

    const agg = new OutcomeAggregator();
    const outcome = await agg.aggregate(makeExecution({ absPath: tmpDir }));

    expect(outcome.status).toBe("failed");
    expect(outcome.source).toBe("disk");
  });

  it("disk-primary: maps 'running' RunState status to 'other' (sc-3-7)", async () => {
    await writeRunState(tmpDir, makeState({ runId: "r-running", status: "running", startedAt: "2026-06-01T00:00:00.000Z" }));

    const agg = new OutcomeAggregator();
    const outcome = await agg.aggregate(makeExecution({ absPath: tmpDir }));

    expect(outcome.status).toBe("other");
    expect(outcome.source).toBe("disk");
  });

  it("exit-code fallback: no states → exitCode 0 maps to 'completed' (sc-3-8)", async () => {
    // No RunState files written — tmpDir has no .bober/runs
    const agg = new OutcomeAggregator();
    const outcome = await agg.aggregate(makeExecution({ absPath: tmpDir, exitCode: 0 }));

    expect(outcome.source).toBe("exit-code");
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(0);
  });

  it("exit-code fallback: no states → non-zero exitCode maps to 'failed' (sc-3-8)", async () => {
    const agg = new OutcomeAggregator();
    const outcome = await agg.aggregate(makeExecution({ absPath: tmpDir, exitCode: 3 }));

    expect(outcome.source).toBe("exit-code");
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(3);
  });

  it("exit-code fallback: null exitCode maps to 'failed' (sc-3-8)", async () => {
    const agg = new OutcomeAggregator();
    const outcome = await agg.aggregate(makeExecution({ absPath: tmpDir, exitCode: null }));

    expect(outcome.source).toBe("exit-code");
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(-1);
  });

  it("scaffold-error path → 'failed' with source 'exit-code' (sc-3-8)", async () => {
    const agg = new OutcomeAggregator();
    const execution = makeExecution({ scaffoldError: "mkdir failed: permission denied" });
    const outcome = await agg.aggregate(execution);

    expect(outcome.status).toBe("failed");
    expect(outcome.source).toBe("exit-code");
    expect(outcome.exitCode).toBe(-1);
    expect(execution.spawn).toBeUndefined();
  });

  it("aggregate never throws on a missing or garbage run dir (sc-3-8)", async () => {
    const agg = new OutcomeAggregator();
    // Non-existent path
    const execution = makeExecution({ absPath: join(tmpDir, "nonexistent-xyz") });
    const outcome = await expect(agg.aggregate(execution)).resolves.toBeDefined();
    expect(outcome).toBeDefined();
  });
});
