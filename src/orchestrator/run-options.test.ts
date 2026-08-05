// ── run-options.test.ts ──────────────────────────────────────────────
//
// sc-4-3: the engine seam accepts a NAMED RunOptions.
//
// Before this existed, PipelineEngine.run declared `{ runId?: string }` while
// real callers passed `{ runId, teamId }` and `{ runId, now }`. Those extra
// fields rode along on structural widening the interface never declared, so
// nothing — not the compiler, not a test — checked them. The assertions here
// are deliberately type-level: `npx tsc --noEmit` is the verification method,
// and each `satisfies` below fails the build if the seam narrows again.

import { describe, it, expect } from "vitest";

import type { BoberConfig } from "../config/schema.js";
import type { PipelineResult } from "./pipeline.js";
import type { PipelineEngine, RunOptions } from "./workflow/engine.js";
import type { RunInWorktreeOpts } from "./worktree.js";
import type { RunManager } from "../mcp/run-manager.js";
import { TsPipelineEngine } from "./workflow/ts-engine.js";
import { WorkflowEngine } from "./workflow/workflow-engine.js";
import { runPipeline } from "./pipeline.js";

// ── Type-level fixtures (compiled, never executed) ───────────────────

/** Every field sc-4-3 enumerates, assignable in one literal. */
const FULL_OPTIONS = {
  runId: "run-1",
  teamId: "programming",
  now: "2026-08-05T00:00:00.000Z",
  signal: new AbortController().signal,
  resume: true,
} satisfies RunOptions;

/** The seam is the engine interface, not a per-engine convention. */
type EngineRun = PipelineEngine["run"];

/** A pipelineFn that consumes the full options bag... */
const widePipelineFn = (
  _task: string,
  _projectRoot: string,
  _config: BoberConfig,
  _opts?: RunOptions,
): Promise<PipelineResult> => Promise.reject(new Error("never called"));

/** ...is accepted by BOTH injection seams that previously declared 3 params. */
const worktreeOpts = { pipelineFn: widePipelineFn } satisfies RunInWorktreeOpts;
type StartRunPipelineFn = Parameters<RunManager["startRun"]>[3];
const managerFn: StartRunPipelineFn = widePipelineFn;

/** The real runPipeline is still assignable to the widened seams. */
const managerDefault: StartRunPipelineFn = runPipeline;
const worktreeDefault = { pipelineFn: runPipeline } satisfies RunInWorktreeOpts;

// ── Tests ────────────────────────────────────────────────────────────

describe("RunOptions (sc-4-3)", () => {
  it("covers runId, teamId, now, signal and resume", () => {
    expect(Object.keys(FULL_OPTIONS).sort()).toEqual([
      "now",
      "resume",
      "runId",
      "signal",
      "teamId",
    ]);
    expect(FULL_OPTIONS.signal.aborted).toBe(false);
  });

  it("every shipped engine's run() satisfies the shared seam", () => {
    const engines: PipelineEngine[] = [new TsPipelineEngine(), new WorkflowEngine()];
    for (const engine of engines) {
      const run: EngineRun = engine.run.bind(engine);
      // 4 declared parameters: prompt, root, config, opts.
      expect(run.length).toBeLessThanOrEqual(4);
    }
    expect(engines.map((e) => e.name)).toEqual(["ts", "workflow"]);
  });

  it("both pipelineFn injection seams accept a RunOptions-consuming function", () => {
    // Compilation is the assertion; these keep the bindings live at runtime so
    // the file cannot be tree-shaken into a no-op.
    expect(typeof worktreeOpts.pipelineFn).toBe("function");
    expect(typeof managerFn).toBe("function");
    expect(managerDefault).toBe(runPipeline);
    expect(worktreeDefault.pipelineFn).toBe(runPipeline);
  });
});
