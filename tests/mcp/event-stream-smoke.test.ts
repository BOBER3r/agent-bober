/**
 * Integration smoke test: event-stream with real Server + Client via InMemoryTransport.
 *
 * Verifies that:
 * 1. bober_subscribe_events returns a subscriptionId when called via real JSON-RPC.
 * 2. Appending a matching line to history.jsonl results in a `bober/events` notification
 *    received by the Client within 1 second.
 *
 * Uses InMemoryTransport.createLinkedPair() to wire a real Server + Client in-process
 * without a subprocess, satisfying stopConditions[3] (real server-initiated notifications).
 */

import { mkdtemp, rm, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { Server } from "@modelcontextprotocol/sdk/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";

import { registerAllTools, getAllTools, getTool } from "../../src/mcp/tools/index.js";
import { initEventStream, getEventStream } from "../../src/mcp/event-stream.js";

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;
let boberDir: string;
let server: Server;
let client: Client;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-smoke-"));
  boberDir = join(tmpDir, ".bober");
  await mkdir(boberDir, { recursive: true });

  // Wire a real Server
  server = new Server(
    { name: "agent-bober-smoke", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = getTool(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
    const result = await tool.handler((args as Record<string, unknown>) ?? {});
    return { content: [{ type: "text" as const, text: result }] };
  });

  // Register tools
  registerAllTools();

  // Wire InMemoryTransport pair
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  // Initialize event stream AFTER server.connect() (mirrors server.ts ordering)
  initEventStream(server, tmpDir, 1000);

  // Connect client
  client = new Client(
    { name: "smoke-client", version: "0.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
});

afterEach(async () => {
  try { getEventStream().shutdown(); } catch { /* ignore */ }
  await client.close();
  await server.close();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Smoke tests ───────────────────────────────────────────────────────

describe("event-stream smoke (InMemoryTransport)", () => {
  it("bober_subscribe_events returns subscriptionId via real JSON-RPC call", async () => {
    const result = await client.callTool({
      name: "bober_subscribe_events",
      arguments: { runId: "smoke-run-1" },
    });

    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as {
      subscriptionId: string;
      status: string;
      startedAt: string;
    };
    expect(parsed.status).toBe("subscribed");
    expect(typeof parsed.subscriptionId).toBe("string");
    expect(parsed.subscriptionId.length).toBeGreaterThan(0);
  });

  it("appending a matching line to history.jsonl triggers a bober/events notification within 1s", async () => {
    // Subscribe via real JSON-RPC call
    const subscribeResult = await client.callTool({
      name: "bober_subscribe_events",
      arguments: { runId: "smoke-run-2" },
    });
    const subscribeContent = subscribeResult.content as Array<{ type: string; text: string }>;
    const subscribeData = JSON.parse(subscribeContent[0]!.text) as {
      subscriptionId: string;
    };

    // Set up notification listener on the client
    const receivedNotifications: Notification[] = [];
    client.fallbackNotificationHandler = async (notification: Notification) => {
      receivedNotifications.push(notification);
    };

    // Append a matching line to history.jsonl
    const line =
      JSON.stringify({
        timestamp: "2026-05-25T10:00:00Z",
        event: "sprint-started",
        phase: "planning",
        runId: "smoke-run-2",
        details: {},
      }) + "\n";

    await appendFile(join(boberDir, "history.jsonl"), line);

    // Wait up to 1 second for the notification
    const deadline = Date.now() + 1000;
    while (receivedNotifications.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(receivedNotifications.length).toBeGreaterThan(0);
    const notif = receivedNotifications[0] as unknown as {
      method: string;
      params: { subscriptionId: string; event: { runId: string } };
    };
    expect(notif.method).toBe("bober/events");
    expect(notif.params.subscriptionId).toBe(subscribeData.subscriptionId);
    expect(notif.params.event).toMatchObject({ runId: "smoke-run-2" });
  });
});
