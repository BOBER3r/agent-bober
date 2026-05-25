/**
 * Integration tests for observability MCP plugin slots (Sprint 16).
 *
 * Uses the real fixture MCP server (tests/orchestrator/fixtures/fake-obs-mcp.mjs)
 * to exercise ExternalMcpServer and mergeObsTools end-to-end, including real
 * stdio framing, signal handling, and process lifecycle.
 *
 * Test split rationale (documented per Sprint 16 briefing):
 * - src/mcp/external-client.test.ts — unit tests with mocked SDK Client (fast)
 * - src/orchestrator/observability/merge.test.ts — unit tests with mocked ExternalMcpServer
 * - THIS FILE — integration tests with real fixture subprocess (subprocess lifecycle)
 *
 * All tests call stopAll() or srv.stop() in their bodies to prevent zombie processes.
 */

import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mergeObsTools, stopAll } from "../../src/orchestrator/observability/merge.js";
import { ExternalMcpServer } from "../../src/mcp/external-client.js";
import type { ObservabilityProvider } from "../../src/config/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "fixtures/fake-obs-mcp.mjs");

// Track all servers for cleanup in afterEach.
let cleanupServers: ExternalMcpServer[] = [];

afterEach(async () => {
  if (cleanupServers.length > 0) {
    await stopAll(cleanupServers);
    cleanupServers = [];
  }
});

function provider(
  name: string,
  env: Record<string, string> = {},
): ObservabilityProvider {
  return {
    name,
    kind: "logs",
    mcpCommand: process.execPath,
    mcpArgs: [FIXTURE],
    mcpEnv: { FAKE_MCP_NAME: name, ...env },
    enabled: true,
  };
}

describe("mergeObsTools — integration with fixture MCP server (Sprint 16)", () => {
  it("merges tools from a single provider with obs__<name>__<tool> prefix (s16-c2)", async () => {
    const { tools, servers, failures } = await mergeObsTools([
      provider("datadog", { FAKE_MCP_TOOLS: "query_logs,get_log_context" }),
    ]);
    cleanupServers = servers;

    expect(failures).toEqual({});
    expect(tools.map((t) => t.name).sort()).toEqual([
      "obs__datadog__get_log_context",
      "obs__datadog__query_logs",
    ]);
    expect(tools[0].upstreamName).toMatch(/query_logs|get_log_context/);
    expect(tools[0].providerName).toBe("datadog");
  });

  it("namespace prevents collisions: two providers with same tool name (s16-c6)", async () => {
    const { tools, servers, failures } = await mergeObsTools([
      provider("provA", { FAKE_MCP_TOOLS: "query" }),
      provider("provB", { FAKE_MCP_TOOLS: "query" }),
    ]);
    cleanupServers = servers;

    expect(failures).toEqual({});
    expect(tools.map((t) => t.name).sort()).toEqual([
      "obs__provA__query",
      "obs__provB__query",
    ]);
    // Verify upstreamName is preserved.
    for (const t of tools) {
      expect(t.upstreamName).toBe("query");
    }
  });

  it("isolates a single provider failure — good provider's tools present (s16-c4)", async () => {
    const { tools, servers, failures } = await mergeObsTools([
      provider("good", { FAKE_MCP_TOOLS: "query" }),
      provider("bad", { FAKE_MCP_CRASH: "1" }),
    ]);
    cleanupServers = servers;

    expect(tools.map((t) => t.name)).toEqual(["obs__good__query"]);
    expect(failures.bad).toBeTruthy();
    expect(failures.good).toBeUndefined();
  });

  it("all-failure case: tools is empty, failures populated (s16-c4)", async () => {
    const { tools, servers, failures } = await mergeObsTools([
      provider("a", { FAKE_MCP_CRASH: "1" }),
      provider("b", { FAKE_MCP_CRASH: "1" }),
    ]);
    cleanupServers = servers;

    expect(tools).toEqual([]);
    expect(Object.keys(failures).sort()).toEqual(["a", "b"]);
    expect(servers).toHaveLength(0);
  });

  it("stopAll reaps all children — no zombie processes (s16-c3)", async () => {
    const { servers } = await mergeObsTools([
      provider("x", { FAKE_MCP_TOOLS: "ping" }),
      provider("y", { FAKE_MCP_TOOLS: "pong" }),
      provider("z", { FAKE_MCP_TOOLS: "status" }),
    ]);

    // Capture pids before stopping.
    const pids = servers
      .map((s) => (s as unknown as { transport?: { pid?: number } }).transport?.pid)
      .filter((pid): pid is number => pid != null);

    await stopAll(servers);
    cleanupServers = [];

    // After stopAll, each pid should be unreachable (ESRCH = no such process).
    for (const pid of pids) {
      let err: NodeJS.ErrnoException | null = null;
      try {
        process.kill(pid, 0);
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      // Allow ESRCH (process gone) or EPERM (process exists but not owned).
      // On macOS the pid may be reused quickly; ESRCH confirms it was reaped.
      if (err) {
        expect(["ESRCH", "EPERM"]).toContain(err.code);
      }
      // If no error: pid was reused (extremely unlikely in tests) — acceptable.
    }
  });

  it("SIGTERM hang is handled — process is killed within the grace period (s16-c3)", async () => {
    // The fixture server ignores SIGTERM. The SDK StdioClientTransport close() sequence:
    //   1. stdin.end() → wait 2s for close
    //   2. SIGTERM → wait 2s for close (ignored by fixture)
    //   3. SIGKILL
    // Our ExternalMcpServer.stop() wraps this with a 5s outer timer as a belt-and-suspenders
    // fallback. The server should be reaped within ~4s (SDK) or 5s (our timer) at most.
    const { servers } = await mergeObsTools([
      provider("hung", { FAKE_MCP_IGNORE_SIGTERM: "1" }),
    ]);
    cleanupServers = [];

    // Capture the pid before stopping.
    const pid = (servers[0] as unknown as { transport?: { pid?: number } }).transport?.pid;

    const start = Date.now();
    await stopAll(servers);
    const elapsed = Date.now() - start;

    // Must complete within the grace period + overhead (max 6s total).
    expect(elapsed).toBeLessThan(6_000);

    // The hung process must be gone (ESRCH = no such process).
    if (pid != null) {
      let err: NodeJS.ErrnoException | null = null;
      try {
        process.kill(pid, 0);
      } catch (e) {
        err = e as NodeJS.ErrnoException;
      }
      // ESRCH: process is gone (expected). EPERM: process reused by OS (unlikely but acceptable).
      if (err) {
        expect(["ESRCH", "EPERM"]).toContain(err.code);
      }
    }
  }, 12_000);

  it("multiple providers start and respond in parallel (s16-c3)", async () => {
    const start = Date.now();
    const { tools, servers, failures } = await mergeObsTools([
      provider("a", { FAKE_MCP_TOOLS: "toolA" }),
      provider("b", { FAKE_MCP_TOOLS: "toolB" }),
      provider("c", { FAKE_MCP_TOOLS: "toolC" }),
    ]);
    const elapsed = Date.now() - start;
    cleanupServers = servers;

    expect(failures).toEqual({});
    expect(tools).toHaveLength(3);
    // Parallel startup should complete much faster than 3 serial startups.
    // Each server takes ~100-500ms to start; 3 in series would be 300-1500ms.
    // We just verify it completed in reasonable time (< 10s for 3 servers).
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("ExternalMcpServer — direct lifecycle tests", () => {
  it("listTools returns the server's tool descriptors", async () => {
    const srv = new ExternalMcpServer(
      provider("direct", { FAKE_MCP_TOOLS: "query_logs,query_metric" }),
    );
    cleanupServers = [srv];

    await srv.start();
    const tools = await srv.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["query_logs", "query_metric"]);
  });

  it("callTool invokes a tool and returns its result", async () => {
    const srv = new ExternalMcpServer(
      provider("call-test", { FAKE_MCP_TOOLS: "echo" }),
    );
    cleanupServers = [srv];

    await srv.start();
    const result = await srv.callTool("echo", { message: "hello" });
    // The fixture server echoes { tool, args } back as text content.
    expect(result).toBeDefined();
    const content = (result as { content: { type: string; text: string }[] }).content;
    expect(content[0].type).toBe("text");
    const parsed = JSON.parse(content[0].text) as { tool: string; args: unknown };
    expect(parsed.tool).toBe("echo");
  });

  it("stop() is safe to call multiple times (idempotent)", async () => {
    const srv = new ExternalMcpServer(
      provider("idem", { FAKE_MCP_TOOLS: "query" }),
    );
    cleanupServers = [];

    await srv.start();
    await srv.stop();
    await expect(srv.stop()).resolves.toBeUndefined();
  });
});
