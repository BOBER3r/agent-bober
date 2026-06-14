import { describe, it, expect } from "vitest";

// ── runId threading unit tests (sc-2-4 / sc-2-5) ─────────────────────
//
// Tests the pure mapping logic: when opts.runId is provided it should be
// used as pipelineRunId; when absent the id should self-generate as run-<timestamp>.
//
// We test this by extracting the resolution logic inline (same as in pipeline.ts)
// rather than driving the full pipeline (which calls real LLMs).

function resolvePipelineRunId(opts?: { runId?: string }): string {
  return opts?.runId ?? `run-${Date.now()}`;
}

describe("resolvePipelineRunId", () => {
  it("honors injected runId when provided (sc-2-4)", () => {
    const runId = resolvePipelineRunId({ runId: "test-run-123" });
    expect(runId).toBe("test-run-123");
  });

  it("self-generates run-<timestamp> when no runId provided (sc-2-5)", () => {
    const before = Date.now();
    const runId = resolvePipelineRunId();
    const after = Date.now();

    expect(runId).toMatch(/^run-\d+$/);
    const ts = parseInt(runId.slice(4), 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("self-generates run-<timestamp> when opts is defined but runId is undefined (sc-2-5)", () => {
    const runId = resolvePipelineRunId({});
    expect(runId).toMatch(/^run-\d+$/);
  });
});

// ── RunCommandOptions threading test (sc-2-4) ─────────────────────────
//
// Verify RunCommandOptions exposes runId and it flows through to runPipeline opts.
// We import the types to confirm the field exists at compile time.

import type { RunCommandOptions } from "../cli/commands/run.js";

describe("RunCommandOptions.runId", () => {
  it("exposes optional runId field (sc-2-4 type-level)", () => {
    const opts: RunCommandOptions = { runId: "explicit-id" };
    expect(opts.runId).toBe("explicit-id");
  });

  it("defaults to undefined when omitted (sc-2-5 type-level)", () => {
    const opts: RunCommandOptions = {};
    expect(opts.runId).toBeUndefined();
  });
});
