/**
 * Unit tests for bober_unsubscribe_events tool.
 */

import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { registerSubscribeEventsTool } from "./subscribe-events.js";
import { registerUnsubscribeEventsTool } from "./unsubscribe-events.js";
import { getTool } from "./registry.js";
import { initEventStream } from "../event-stream.js";

// ── Fake Server ──────────────────────────────────────────────────────

function makeFakeServer() {
  return { notification: vi.fn().mockResolvedValue(undefined) };
}

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-unsubscribe-tool-test-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
  registerSubscribeEventsTool();
  registerUnsubscribeEventsTool();
  initEventStream(makeFakeServer() as never, tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("bober_unsubscribe_events", () => {
  it("is registered with the correct name", () => {
    expect(getTool("bober_unsubscribe_events")).toBeDefined();
  });

  it("returns status=unsubscribed for a valid subscriptionId", async () => {
    // First subscribe
    const subscribeTool = getTool("bober_subscribe_events")!;
    const subResult = JSON.parse(await subscribeTool.handler({ runId: "run-unsub" })) as {
      subscriptionId: string;
    };

    // Then unsubscribe
    const tool = getTool("bober_unsubscribe_events")!;
    const rawResult = await tool.handler({ subscriptionId: subResult.subscriptionId });
    const result = JSON.parse(rawResult) as { subscriptionId: string; status: string };

    expect(result.status).toBe("unsubscribed");
    expect(result.subscriptionId).toBe(subResult.subscriptionId);
  });

  it("returns soft error JSON when subscriptionId is not found", async () => {
    const tool = getTool("bober_unsubscribe_events")!;
    const rawResult = await tool.handler({ subscriptionId: "nonexistent-id" });
    const result = JSON.parse(rawResult) as { error: string };
    expect(result.error).toMatch(/Subscription not found/);
    expect(result.error).toContain("nonexistent-id");
  });

  it("throws McpError(InvalidRequest) when subscriptionId is missing", async () => {
    const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
    const tool = getTool("bober_unsubscribe_events")!;
    await expect(tool.handler({})).rejects.toThrow(McpError);
  });

  it("throws McpError(InvalidRequest) when subscriptionId is an empty string", async () => {
    const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
    const tool = getTool("bober_unsubscribe_events")!;
    await expect(tool.handler({ subscriptionId: "" })).rejects.toThrow(McpError);
  });
});
