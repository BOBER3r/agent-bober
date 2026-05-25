/**
 * Unit tests for bober_subscribe_events tool.
 */

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerSubscribeEventsTool } from "./subscribe-events.js";
import { getTool } from "./registry.js";
import { initEventStream } from "../event-stream.js";

// ── Fake Server ──────────────────────────────────────────────────────

function makeFakeServer() {
  return { notification: vi.fn().mockResolvedValue(undefined) };
}

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-subscribe-tool-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
  registerSubscribeEventsTool();
  // Initialize event stream with a fake server for this test
  initEventStream(makeFakeServer() as never, tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_subscribe_events", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_subscribe_events")).toBeDefined();
  });

  it("returns a subscriptionId and status=subscribed for a valid runId", async () => {
    const tool = getTool("bober_subscribe_events")!;
    const rawResult = await tool.handler({ runId: "run-test" });
    const result = JSON.parse(rawResult) as {
      subscriptionId: string;
      status: string;
      startedAt: string;
    };
    expect(result.status).toBe("subscribed");
    expect(typeof result.subscriptionId).toBe("string");
    expect(result.subscriptionId.length).toBeGreaterThan(0);
    expect(typeof result.startedAt).toBe("string");
  });

  it("returns a subscriptionId when since is provided", async () => {
    const tool = getTool("bober_subscribe_events")!;
    const rawResult = await tool.handler({
      runId: "run-with-since",
      since: "2026-05-25T00:00:00Z",
    });
    const result = JSON.parse(rawResult) as { status: string };
    expect(result.status).toBe("subscribed");
  });

  it("throws McpError(InvalidRequest) when runId is missing", async () => {
    const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
    const tool = getTool("bober_subscribe_events")!;
    await expect(tool.handler({})).rejects.toThrow(McpError);
  });

  it("throws McpError(InvalidRequest) when runId is an empty string", async () => {
    const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
    const tool = getTool("bober_subscribe_events")!;
    await expect(tool.handler({ runId: "   " })).rejects.toThrow(McpError);
  });
});
