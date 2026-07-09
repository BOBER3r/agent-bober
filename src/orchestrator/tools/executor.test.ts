/**
 * Unit tests for `executeToolBatch` (sprint-4: sc-4-1..sc-4-4) and the
 * `readOnly` schema annotations (sc-4-1).
 *
 * Uses fake handlers (no real filesystem/shell access) so concurrency can be
 * proven with real `setTimeout` delays and `performance.now()` wall-clock
 * measurements — vitest does NOT enable fake timers in this project (no
 * global setup file), so real timers are the default here; do not add
 * `vi.useFakeTimers()` in this file (it would make delays resolve instantly
 * and defeat the overlap proof).
 */

import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";

import { executeToolBatch } from "./executor.js";
import type { ToolHandler } from "./handlers.js";
import {
  readFileTool,
  globTool,
  grepTool,
  bashTool,
  writeFileTool,
  editFileTool,
} from "./schemas.js";

// ── sc-4-1: readOnly annotation coverage ─────────────────────────────

describe("ToolDef.readOnly annotation coverage (sc-4-1)", () => {
  it("marks exactly read_file, glob and grep readOnly:true", () => {
    expect(readFileTool.readOnly).toBe(true);
    expect(globTool.readOnly).toBe(true);
    expect(grepTool.readOnly).toBe(true);
  });

  it("leaves bash, write_file and edit_file unmarked (undefined, not false)", () => {
    expect(bashTool.readOnly).toBeUndefined();
    expect(writeFileTool.readOnly).toBeUndefined();
    expect(editFileTool.readOnly).toBeUndefined();
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────

/** A handler that resolves after `ms` with a fixed output, recording call order. */
function delayedHandler(
  ms: number,
  out: string,
  callOrder: string[],
  name: string,
): ToolHandler {
  return async () => {
    callOrder.push(name);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { output: out, isError: false };
  };
}

/** A handler that resolves immediately, recording call order. */
function immediateHandler(out: string, callOrder: string[], name: string): ToolHandler {
  return async () => {
    callOrder.push(name);
    return { output: out, isError: false };
  };
}

/** A handler that always throws. */
function throwingHandler(message: string): ToolHandler {
  return async () => {
    throw new Error(message);
  };
}

const READ_ONLY_NAMES = new Set(["read_file", "glob", "grep"]);

// ── sc-4-2: proven concurrency + order preservation ──────────────────

describe("executeToolBatch — concurrency proof (sc-4-2)", () => {
  it("overlaps delayed read-only handlers when parallel:true (elapsed << sum of delays)", async () => {
    const callOrder: string[] = [];
    const handlers = new Map<string, ToolHandler>([
      ["read_file", delayedHandler(50, "a", callOrder, "read_file")],
      ["glob", delayedHandler(50, "b", callOrder, "glob")],
      ["grep", delayedHandler(50, "c", callOrder, "grep")],
    ]);
    const calls = [
      { id: "t1", name: "read_file", input: {} },
      { id: "t2", name: "glob", input: {} },
      { id: "t3", name: "grep", input: {} },
    ];

    const t0 = performance.now();
    const results = await executeToolBatch({
      toolCalls: calls,
      toolHandlers: handlers,
      readOnlyTools: READ_ONLY_NAMES,
      parallel: true,
    });
    const elapsed = performance.now() - t0;

    // Sum of delays is ~150ms; concurrent execution should finish well under that.
    expect(elapsed).toBeLessThan(120);

    // Order preserved by original position/toolUseId, regardless of completion order.
    expect(results.map((r) => r.toolUseId)).toEqual(["t1", "t2", "t3"]);
    expect(results.map((r) => r.content)).toEqual(["a", "b", "c"]);
    expect(results.every((r) => r.isError === false)).toBe(true);
  });

  it("meaningful-fixture guard: the SAME batch run with parallel:false takes >= 140ms", async () => {
    const callOrder: string[] = [];
    const handlers = new Map<string, ToolHandler>([
      ["read_file", delayedHandler(50, "a", callOrder, "read_file")],
      ["glob", delayedHandler(50, "b", callOrder, "glob")],
      ["grep", delayedHandler(50, "c", callOrder, "grep")],
    ]);
    const calls = [
      { id: "t1", name: "read_file", input: {} },
      { id: "t2", name: "glob", input: {} },
      { id: "t3", name: "grep", input: {} },
    ];

    const t0 = performance.now();
    const results = await executeToolBatch({
      toolCalls: calls,
      toolHandlers: handlers,
      readOnlyTools: READ_ONLY_NAMES,
      parallel: false,
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(results.map((r) => r.toolUseId)).toEqual(["t1", "t2", "t3"]);
  });
});

// ── sc-4-3: in-slot error containment, never rejects ──────────────────

describe("executeToolBatch — in-slot error containment (sc-4-3)", () => {
  it("a throwing middle handler produces an isError result in its own slot; others normal; promise resolves", async () => {
    const handlers = new Map<string, ToolHandler>([
      ["read_file", immediateHandler("a", [], "read_file")],
      ["glob", throwingHandler("boom")],
      ["grep", immediateHandler("c", [], "grep")],
    ]);
    const calls = [
      { id: "t1", name: "read_file", input: {} },
      { id: "t2", name: "glob", input: {} },
      { id: "t3", name: "grep", input: {} },
    ];

    await expect(
      executeToolBatch({
        toolCalls: calls,
        toolHandlers: handlers,
        readOnlyTools: READ_ONLY_NAMES,
        parallel: true,
      }),
    ).resolves.toBeDefined();

    const results = await executeToolBatch({
      toolCalls: calls,
      toolHandlers: handlers,
      readOnlyTools: READ_ONLY_NAMES,
      parallel: true,
    });

    expect(results[0]).toEqual({ toolUseId: "t1", content: "a", isError: false });
    expect(results[1]).toEqual({
      toolUseId: "t2",
      // Exact shape mirrored from the serial path's thrown-handler branch.
      content: "Error: Tool execution failed: boom",
      isError: true,
    });
    expect(results[2]).toEqual({ toolUseId: "t3", content: "c", isError: false });
  });

  it("an unknown tool in the middle of a parallel batch produces the serial-path unknown-tool shape", async () => {
    const handlers = new Map<string, ToolHandler>([
      ["read_file", immediateHandler("a", [], "read_file")],
      ["grep", immediateHandler("c", [], "grep")],
    ]);
    const calls = [
      { id: "t1", name: "read_file", input: {} },
      { id: "t2", name: "glob", input: {} }, // no handler registered for "glob"
      { id: "t3", name: "grep", input: {} },
    ];

    const results = await executeToolBatch({
      toolCalls: calls,
      toolHandlers: handlers,
      readOnlyTools: READ_ONLY_NAMES,
      parallel: true,
    });

    expect(results[0]).toEqual({ toolUseId: "t1", content: "a", isError: false });
    expect(results[1]).toEqual({
      toolUseId: "t2",
      content: `Error: Unknown tool "glob". Available tools: ${[...handlers.keys()].join(", ")}`,
      isError: true,
    });
    expect(results[2]).toEqual({ toolUseId: "t3", content: "c", isError: false });
  });
});

// ── sc-4-4: byte-identical serial fallback ─────────────────────────────

describe("executeToolBatch — byte-identical serial fallback (sc-4-4)", () => {
  it("parallel:false invokes handlers strictly in input order (call-order proof)", async () => {
    const callOrder: string[] = [];
    const handlers = new Map<string, ToolHandler>([
      ["read_file", immediateHandler("a", callOrder, "read_file")],
      ["glob", immediateHandler("b", callOrder, "glob")],
      ["grep", immediateHandler("c", callOrder, "grep")],
    ]);
    const calls = [
      { id: "t1", name: "grep", input: {} },
      { id: "t2", name: "read_file", input: {} },
      { id: "t3", name: "glob", input: {} },
    ];

    const results = await executeToolBatch({
      toolCalls: calls,
      toolHandlers: handlers,
      readOnlyTools: READ_ONLY_NAMES,
      parallel: false,
    });

    expect(callOrder).toEqual(["grep", "read_file", "glob"]);
    expect(results.map((r) => r.toolUseId)).toEqual(["t1", "t2", "t3"]);
  });

  it("an unmarked (write) tool batch stays serial even when parallel:true", async () => {
    const callOrder: string[] = [];
    const handlers = new Map<string, ToolHandler>([
      ["write_file", delayedHandler(30, "w1", callOrder, "write_file-1")],
      ["edit_file", delayedHandler(30, "w2", callOrder, "edit_file")],
      ["bash", delayedHandler(30, "w3", callOrder, "bash")],
    ]);
    const calls = [
      { id: "t1", name: "write_file", input: {} },
      { id: "t2", name: "edit_file", input: {} },
      { id: "t3", name: "bash", input: {} },
    ];

    // readOnlyTools is empty — none of these are annotated read-only, so even
    // with parallel:true nothing is eligible for concurrency (contract nonGoal:
    // never parallelize write tools).
    const t0 = performance.now();
    const results = await executeToolBatch({
      toolCalls: calls,
      toolHandlers: handlers,
      readOnlyTools: new Set(),
      parallel: true,
    });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(80); // ~90ms serial (3 x 30ms), never overlaps
    expect(callOrder).toEqual(["write_file-1", "edit_file", "bash"]);
    expect(results.map((r) => r.toolUseId)).toEqual(["t1", "t2", "t3"]);
  });

  it("never rejects even when every call fails", async () => {
    const handlers = new Map<string, ToolHandler>([
      ["read_file", throwingHandler("fail-1")],
      ["glob", throwingHandler("fail-2")],
    ]);
    const calls = [
      { id: "t1", name: "read_file", input: {} },
      { id: "t2", name: "glob", input: {} },
    ];

    await expect(
      executeToolBatch({
        toolCalls: calls,
        toolHandlers: handlers,
        readOnlyTools: READ_ONLY_NAMES,
        parallel: true,
      }),
    ).resolves.toHaveLength(2);
  });

  it("fires onToolUse for every call, including unknown ones, before the handler lookup", async () => {
    const fired: string[] = [];
    const handlers = new Map<string, ToolHandler>([
      ["read_file", immediateHandler("a", [], "read_file")],
    ]);
    const calls = [
      { id: "t1", name: "read_file", input: { foo: 1 } },
      { id: "t2", name: "does_not_exist", input: { bar: 2 } },
    ];

    const results = await executeToolBatch({
      toolCalls: calls,
      toolHandlers: handlers,
      readOnlyTools: READ_ONLY_NAMES,
      parallel: false,
      onToolUse: (name) => fired.push(name),
    });

    expect(fired).toEqual(["read_file", "does_not_exist"]);
    expect(results[1].isError).toBe(true);
  });
});
