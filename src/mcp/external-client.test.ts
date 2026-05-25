/**
 * Unit tests for ExternalMcpServer.
 *
 * Uses mocked SDK Client and StdioClientTransport (Approach A from Sprint 16 briefing)
 * for fast, subprocess-free class-logic verification. Integration tests using a real
 * fixture MCP server live in tests/orchestrator/observability-mcp.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK modules before importing the module under test.
// vi.mock is hoisted to the top of the file by Vitest's transform.
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    { name: "query_logs", description: "Query logs", inputSchema: { type: "object" } },
  ],
});
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: "text", text: "ok" }],
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
  })),
}));

const mockPid = 99999;
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({
    get pid() { return mockPid; },
  })),
}));

import { ExternalMcpServer } from "./external-client.js";
import type { ObservabilityProvider } from "../config/schema.js";

function makeProvider(overrides: Partial<ObservabilityProvider> = {}): ObservabilityProvider {
  return {
    name: "test-provider",
    kind: "logs",
    mcpCommand: "node",
    mcpArgs: [],
    enabled: true,
    ...overrides,
  };
}

describe("ExternalMcpServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default mock implementations
    mockClose.mockResolvedValue(undefined);
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        { name: "query_logs", description: "Query logs", inputSchema: { type: "object" } },
      ],
    });
    mockCallTool.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
  });

  describe("name getter", () => {
    it("returns the provider name", () => {
      const srv = new ExternalMcpServer(makeProvider({ name: "loki" }));
      expect(srv.name).toBe("loki");
    });
  });

  describe("start()", () => {
    it("calls client.connect with the transport", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — second call does not reconnect", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();
      await srv.start();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("merges process.env with mcpEnv for the child (security: mcpEnv does not appear in errors)", async () => {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const srv = new ExternalMcpServer(
        makeProvider({ mcpEnv: { SECRET_TOKEN: "supersecret" } }),
      );
      await srv.start();
      // Verify the transport was created — the env merge happens in the constructor.
      expect(StdioClientTransport).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(StdioClientTransport).mock.calls[0][0];
      expect(callArgs.env).toBeDefined();
      // mcpEnv values must be present in the spawned env (so the child can read them).
      expect(callArgs.env?.SECRET_TOKEN).toBe("supersecret");
    });

    it("throws an error without exposing mcpEnv when connect fails", async () => {
      mockConnect.mockRejectedValueOnce(new Error("LOKI_TOKEN=secret connection refused"));
      const srv = new ExternalMcpServer(makeProvider({ name: "loki" }));
      let caughtError: Error | undefined;
      try {
        await srv.start();
      } catch (err) {
        caughtError = err as Error;
      }
      expect(caughtError).toBeDefined();
      expect(caughtError?.message).toMatch(/loki.*failed to connect/i);
      // The error message must NOT contain the raw env var value — SECURITY check.
      expect(caughtError?.message).not.toContain("secret");
      // The raw env var assignment pattern must be redacted.
      expect(caughtError?.message).toContain("[redacted]");
    });
  });

  describe("listTools()", () => {
    it("returns tool descriptors after start", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();
      const tools = await srv.listTools();
      expect(tools).toEqual([
        { name: "query_logs", description: "Query logs", inputSchema: { type: "object" } },
      ]);
    });

    it("caches tool list — second call does not re-call listTools", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();
      await srv.listTools();
      await srv.listTools();
      expect(mockListTools).toHaveBeenCalledTimes(1);
    });

    it("throws if called before start", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await expect(srv.listTools()).rejects.toThrow(/not started/);
    });
  });

  describe("callTool()", () => {
    it("delegates to client.callTool with name and arguments", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();
      const result = await srv.callTool("query_logs", { query: "error" });
      expect(mockCallTool).toHaveBeenCalledWith({
        name: "query_logs",
        arguments: { query: "error" },
      });
      expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    });

    it("throws if called before start", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await expect(srv.callTool("query_logs", {})).rejects.toThrow(/not started/);
    });
  });

  describe("stop()", () => {
    it("calls client.close and cleans up internal refs", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();
      await srv.stop();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — second stop() is a no-op", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();
      await srv.stop();
      await srv.stop();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("is safe to call without ever calling start()", async () => {
      const srv = new ExternalMcpServer(makeProvider());
      await expect(srv.stop()).resolves.toBeUndefined();
      expect(mockClose).not.toHaveBeenCalled();
    });

    it("sends SIGKILL via process.kill when close hangs beyond 5s", async () => {
      // Simulate a hung close by never resolving.
      mockClose.mockReturnValueOnce(new Promise(() => { /* never resolves */ }));
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      const srv = new ExternalMcpServer(makeProvider());
      await srv.start();

      // Use a shorter timeout for the test — we verify the SIGKILL path fires.
      // We can't easily override the 5s constant in the implementation without
      // injection, so we just check that process.kill was called with SIGKILL.
      // The test would hang for 5s without a workaround — use fake timers.
      vi.useFakeTimers();
      const stopPromise = srv.stop();
      await vi.runAllTimersAsync();
      await stopPromise;

      expect(killSpy).toHaveBeenCalledWith(mockPid, "SIGKILL");
      killSpy.mockRestore();
      vi.useRealTimers();
    }, 10_000);
  });
});
