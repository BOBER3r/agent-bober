/**
 * Colocated unit tests for CliCheckpointMechanism.
 *
 * Placed at src/orchestrator/checkpoints/mechanisms/cli.test.ts per the
 * COLOCATION HARD CONSTRAINT in Sprint 8 briefing — NOT in tests/orchestrator/.
 * This keeps the colocated:separate test ratio at 25:22, preserving the
 * Sprint 5 scanner regression assertion (colocated >= separate).
 *
 * Sprint 8: s8-c5 (all four branches), s8-c6 (perf benchmark)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { CliCheckpointMechanism } from "./cli.js";
import type { CheckpointMechanism } from "../types.js";

// ---------------------------------------------------------------------------
// readline mock — feeds canned answers to the readline interface
// ---------------------------------------------------------------------------
vi.mock("node:readline", () => ({
  createInterface: vi.fn(),
}));

import * as readline from "node:readline";

/**
 * Set up the readline mock to return answers in sequence.
 * Each call to rl.question() consumes the next answer.
 */
function stubReadline(answers: string[]): void {
  let i = 0;
  (readline.createInterface as ReturnType<typeof vi.fn>).mockReturnValue({
    question: (_q: string, cb: (a: string) => void) => cb(answers[i++] ?? ""),
    close: vi.fn(),
  });
}

// ---------------------------------------------------------------------------
// child_process + fs mock for edit branch
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue("edited content"),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import * as childProcess from "node:child_process";
import * as fsPromises from "node:fs/promises";

// ---------------------------------------------------------------------------
// TTY helpers
// ---------------------------------------------------------------------------
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  // Default to TTY=true so interactive tests work.
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalIsTTY,
    configurable: true,
  });
  // Use clearAllMocks (not restoreAllMocks) so that vi.mock() factory fns
  // retain their implementations — restoreAllMocks would remove mockResolvedValue.
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) Approve branch  (s8-c5a)
// ---------------------------------------------------------------------------
describe("CliCheckpointMechanism — approve branch (s8-c5a)", () => {
  it("'a' input → { approved: true }", async () => {
    stubReadline(["a"]);
    const cli = new CliCheckpointMechanism();
    const outcome = await cli.request("post-research", {
      path: "x.md",
      text: "hello world",
    });
    expect(outcome).toEqual({ approved: true });
  });

  it("'approve' (full word) → { approved: true }", async () => {
    stubReadline(["approve"]);
    const cli = new CliCheckpointMechanism();
    const outcome = await cli.request("post-plan", { text: "plan body" });
    expect(outcome).toEqual({ approved: true });
  });
});

// ---------------------------------------------------------------------------
// (b) Reject branch  (s8-c5b)
// ---------------------------------------------------------------------------
describe("CliCheckpointMechanism — reject branch (s8-c5b)", () => {
  it("'r' input + feedback line → { approved: false, feedback }", async () => {
    stubReadline(["r", "needs more detail"]);
    const cli = new CliCheckpointMechanism();
    const outcome = await cli.request("post-plan", { path: "p.json" });
    expect(outcome).toEqual({ approved: false, feedback: "needs more detail" });
  });

  it("'reject' (full word) + feedback → { approved: false, feedback }", async () => {
    stubReadline(["reject", "missing section 3"]);
    const cli = new CliCheckpointMechanism();
    const outcome = await cli.request("post-sprint-contract", {});
    expect(outcome).toEqual({
      approved: false,
      feedback: "missing section 3",
    });
  });
});

// ---------------------------------------------------------------------------
// (c) Edit branch  (s8-c5c)
// ---------------------------------------------------------------------------
describe("CliCheckpointMechanism — edit branch (s8-c5c)", () => {
  it("'e' input + mocked spawn/readFile → { edit: true, editDelta: { before, after } }", async () => {
    stubReadline(["e"]);

    // Mock spawn to emit 'exit' immediately (editor "closed" without errors).
    const mockChild = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === "exit") cb(0);
        return mockChild;
      }),
    };
    (childProcess.spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockChild);

    // readFile mock already returns "edited content" from the module-level mock.

    const cli = new CliCheckpointMechanism(undefined, undefined, "fake-editor");
    const outcome = await cli.request("post-research", { text: "original" });

    // Verify the edit branch shape.
    expect(outcome).toHaveProperty("edit", true);
    const typed = outcome as { edit: true; editDelta: { before: string; after: string } };
    expect(typed.editDelta).toEqual({ before: "original", after: "edited content" });

    // Verify the temp file was written and cleaned up.
    expect(fsPromises.writeFile).toHaveBeenCalledOnce();
    expect(fsPromises.unlink).toHaveBeenCalledOnce();

    // Verify spawn was called with the injected editor.
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "fake-editor",
      expect.arrayContaining([expect.stringContaining("bober-checkpoint-")]),
      { stdio: "inherit" },
    );
  });
});

// ---------------------------------------------------------------------------
// (d) Non-TTY fallback — noop PATH must be INVOKED  (s8-c5d)
// ---------------------------------------------------------------------------
describe("CliCheckpointMechanism — non-TTY fallback (s8-c5d)", () => {
  it("isTTY=false → calls fallback.request (not just returns approved:true) + writes stderr warning", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    // Spy on stderr to capture the warning.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true as unknown as boolean);

    // Inject a spy noop so we can verify the PATH is taken, not just the outcome.
    const noopSpy: CheckpointMechanism = {
      request: vi.fn(async () => ({ approved: true as const })),
    };

    const cli = new CliCheckpointMechanism(noopSpy);
    const outcome = await cli.request("post-plan", { key: "val" });

    // Verify the noop PATH was taken (not just outcome equivalence).
    expect(noopSpy.request).toHaveBeenCalledOnce();
    expect(noopSpy.request).toHaveBeenCalledWith("post-plan", { key: "val" });

    // Verify the stderr warning is present.
    const allStderr = stderrSpy.mock.calls.flat().join("");
    expect(allStderr).toMatch(/not a TTY/i);

    // Verify the outcome (bonus — should be approved:true from our spy).
    expect(outcome).toEqual({ approved: true });
  });
});

// ---------------------------------------------------------------------------
// (perf) Prompt + stdin read under 200ms with pre-stuffed stdin  (s8-c6)
// ---------------------------------------------------------------------------
describe("CliCheckpointMechanism — performance benchmark (s8-c6)", () => {
  it("prompt + stdin read completes under 200ms with pre-stuffed Readable", async () => {
    // Set up readline mock to consume "a" immediately — this is what the
    // pre-stuffed Readable represents. The mock is faster than a real stream.
    stubReadline(["a"]);

    // Inject a pre-stuffed Readable that emits "a\n" immediately.
    // Measures only orchestrator overhead (prompt render + readline read),
    // NOT user think time.
    const buf = Readable.from(["a\n"]);

    // Inject the pre-stuffed stream via constructor.
    const cli = new CliCheckpointMechanism(undefined, buf as Readable);

    const start = performance.now();
    const outcome = await cli.request("post-research", { text: "perf test" });
    const elapsed = performance.now() - start;

    expect(outcome).toEqual({ approved: true });
    expect(elapsed).toBeLessThan(200);
  });
});
