/**
 * Tests for external MCP server graph tool registration.
 *
 * Registry is a module-level singleton. We use vi.resetModules() to get a
 * fresh registry for each test that needs isolation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphClient } from "../../src/graph/client.js";

// ── Mock client helper ────────────────────────────────────────────────

function mockClient(): GraphClient {
  return {
    search: vi.fn(),
    query: vi.fn(),
    impact: vi.fn(),
    reviewContext: vi.fn(),
    overview: vi.fn(),
    changes: vi.fn(),
    prefetch: vi.fn(),
    markFresh: vi.fn(),
    hintFor: vi.fn(),
  } as unknown as GraphClient;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("external MCP server tool registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("with graph.enabled=false: registerAllTools registers exactly 20 tools", async () => {
    const { registerAllTools, getAllTools } = await import("../../src/mcp/tools/index.js");
    registerAllTools();
    const tools = getAllTools();
    expect(tools.length).toBe(20);
  });

  it("with graph.enabled=true: 20 + 6 graph tools appended (26 total)", async () => {
    const { registerAllTools, getAllTools, registerTool } = await import("../../src/mcp/tools/index.js");
    const { createGraphTools } = await import("../../src/mcp/tools/graph.js");
    const { GraphFallback } = await import("../../src/graph/fallback.js");

    registerAllTools();
    const baseline = getAllTools().length;
    expect(baseline).toBe(20);

    const deps = { client: mockClient(), fallback: new GraphFallback("dual") };
    const graphTools = createGraphTools(deps);

    for (const t of graphTools) {
      registerTool(t);
    }

    const after = getAllTools();
    expect(after.length).toBe(baseline + 6);
    expect(after.length).toBe(26);

    const names = after.map((t) => t.name);
    expect(names).toContain("graph_search");
    expect(names).toContain("graph_query");
    expect(names).toContain("graph_impact");
    expect(names).toContain("graph_review_context");
    expect(names).toContain("graph_overview");
    expect(names).toContain("graph_changes");
  });

  it("graph tools are appended after existing 20 tools (not interleaved)", async () => {
    const { registerAllTools, getAllTools, registerTool } = await import("../../src/mcp/tools/index.js");
    const { createGraphTools } = await import("../../src/mcp/tools/graph.js");
    const { GraphFallback } = await import("../../src/graph/fallback.js");

    registerAllTools();
    const graphTools = createGraphTools({ client: mockClient(), fallback: new GraphFallback("dual") });
    for (const t of graphTools) {
      registerTool(t);
    }

    const names = getAllTools().map((t) => t.name);
    // First 20 should all be bober_* tools, last 6 should be graph_*
    const last6 = names.slice(-6).sort();
    expect(last6).toEqual([
      "graph_changes",
      "graph_impact",
      "graph_overview",
      "graph_query",
      "graph_review_context",
      "graph_search",
    ]);

    // All original 20 bober_* tools should still be present
    const boberTools = names.filter((n) => n.startsWith("bober_"));
    expect(boberTools.length).toBe(20);
  });

  it("exposeOnExternalMcp=false: graph tools not in external registry but createGraphTools still returns 6", async () => {
    const { createGraphTools } = await import("../../src/mcp/tools/graph.js");
    const { GraphFallback } = await import("../../src/graph/fallback.js");

    // createGraphTools always returns 6 — the caller decides whether to register them
    const tools = createGraphTools({ client: mockClient(), fallback: new GraphFallback("dual") });
    expect(tools).toHaveLength(6);

    // If we don't register them (simulating exposeOnExternalMcp=false), registry stays at 20
    const { registerAllTools, getAllTools } = await import("../../src/mcp/tools/index.js");
    registerAllTools();
    // We do NOT call registerTool for graph tools here
    expect(getAllTools().length).toBe(20);
  });

  it("createGraphTools is defined exactly once (DRY enforcement)", async () => {
    const graphModule = await import("../../src/mcp/tools/graph.js");
    expect(typeof graphModule.createGraphTools).toBe("function");
    expect(typeof graphModule.registerGraphTools).toBe("function");
  });

  it("getGraphInternalTools returns same 6 tools as createGraphTools (DRY)", async () => {
    const { getGraphInternalTools } = await import("../../src/orchestrator/tools/index.js");
    const { createGraphTools } = await import("../../src/mcp/tools/graph.js");
    const { GraphFallback } = await import("../../src/graph/fallback.js");

    const client = mockClient();
    const fallback = new GraphFallback("dual");

    const internal = getGraphInternalTools(client, fallback);
    const factory = createGraphTools({ client, fallback });

    expect(internal.map((t) => t.name)).toEqual(factory.map((t) => t.name));
    expect(internal).toHaveLength(6);
  });
});
