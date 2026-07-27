/**
 * sc-7-4 (sprint 7): external MCP server (`createBoberMCPServer`) constructs
 * its graph_* tools backed by the RESOLVED backend, not a hardcoded
 * tokensave client.
 *
 * server.ts already resolves the backend via resolveGraphBackend (Sprint 3);
 * this test proves it end-to-end by spying on GraphClient's constructor args
 * and asserting the injected backend is CodeReviewGraphBackend when
 * graph.backend="code-review-graph" is configured.
 *
 * Kept in its own file (rather than extending
 * tests/mcp/external-server-graph.test.ts) so its config/loader + client.js
 * mocks — and the real StdioServerTransport / SIGINT-SIGTERM registration
 * createBoberMCPServer performs — cannot leak into that file's lighter-weight
 * tool-registration-only tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hoisted = vi.hoisted(() => ({
  ctorCalls: [] as unknown[][],
}));

vi.mock("../../src/config/loader.js", () => ({
  configExists: vi.fn().mockResolvedValue(true),
  loadConfig: vi.fn().mockResolvedValue({
    graph: {
      enabled: true,
      backend: "code-review-graph",
      exposeOnExternalMcp: true,
      autoSync: false,
      languageTier: "core",
      manifestPath: ".bober/graph/manifest.json",
      syncTimeoutMs: 2_000,
      queryTimeoutMs: 5_000,
      debounceMs: 500,
      hookQueueMax: 10,
      maxEngineRssMb: 512,
    },
    pipeline: {},
  }),
}));

vi.mock("../../src/graph/client.js", () => {
  class SpyGraphClient {
    constructor(...args: unknown[]) {
      hoisted.ctorCalls.push(args);
    }
  }
  return { GraphClient: SpyGraphClient };
});

describe("createBoberMCPServer graph tool wiring through the resolved backend (sc-7-4)", () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.ctorCalls.length = 0;
  });

  it("constructs GraphClient with the resolved code-review-graph backend (not a hardcoded tokensave client)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "bober-mcp-server-cr-graph-"));
    try {
      const { createBoberMCPServer } = await import("../../src/mcp/server.js");
      const server = await createBoberMCPServer(tmp);
      try {
        expect(hoisted.ctorCalls.length).toBe(1);
        // GraphClient(projectRoot, mcpClient, store, fallback, incidents, cfg, backend)
        const args = hoisted.ctorCalls[0]!;
        expect(args.length).toBe(7);
        const backendArg = args[6] as { id: string };
        expect(backendArg.id).toBe("code-review-graph");
      } finally {
        await server.close();
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
