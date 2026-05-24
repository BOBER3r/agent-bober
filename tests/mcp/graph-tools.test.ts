import { describe, it, expect, vi } from "vitest";
import { createGraphTools } from "../../src/mcp/tools/graph.js";
import { GraphFallback } from "../../src/graph/fallback.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { SearchHit, NodeRef, ImpactReport, GraphResult } from "../../src/graph/types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function mockClient(overrides: Partial<Record<keyof GraphClient, unknown>> = {}): GraphClient {
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
    ...overrides,
  } as unknown as GraphClient;
}

function makeFallback(): GraphFallback {
  return new GraphFallback("dual");
}

// ── graph_search ─────────────────────────────────────────────────────

describe("graph_search handler", () => {
  it("formats SearchHit[] as 'file:line — symbol — snippet — score' lines", async () => {
    const hits: SearchHit[] = [
      {
        node: { id: "1", kind: "function", file: "src/foo.ts", line: 42, symbol: "foo" },
        score: 0.9,
        snippet: "function foo()",
      },
    ];
    const client = mockClient({
      search: vi.fn().mockResolvedValue({
        ok: true,
        data: hits,
        backend: "mcp",
        durationMs: 5,
      } as GraphResult<SearchHit[]>),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_search")!;

    const out = await tool.handler({ query: "foo" });
    expect(out).toContain("src/foo.ts:42");
    expect(out).toContain("foo");
    expect(out).toContain("0.900");
  });

  it("returns FallbackHint.message on ok:false", async () => {
    const client = mockClient({
      search: vi.fn().mockResolvedValue({
        ok: false,
        reason: "GRAPH_UNAVAILABLE",
        detail: "engine down",
      } as GraphResult<SearchHit[]>),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_search")!;
    const out = await tool.handler({ query: "foo" });
    expect(out).toContain("unavailable");
    expect(out).toContain("engine down");
  });

  it("truncates output to exactly MAX_OUTPUT_CHARS (100_000)", async () => {
    const huge: SearchHit[] = Array.from({ length: 5000 }, (_, i) => ({
      node: { id: String(i), kind: "function" as const, file: "src/x.ts", line: i, symbol: "x" },
      score: 1,
      snippet: "y".repeat(50),
    }));
    const client = mockClient({
      search: vi.fn().mockResolvedValue({
        ok: true,
        data: huge,
        backend: "mcp" as const,
        durationMs: 1,
      } as GraphResult<SearchHit[]>),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_search")!;
    const out = await tool.handler({ query: "foo" });
    expect(out.length).toBe(100_000);
    expect(out.endsWith("...[truncated due to MAX_OUTPUT_CHARS]")).toBe(true);
  });

  it("rejects empty query via schema validation", async () => {
    const client = mockClient();
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_search")!;
    const out = await tool.handler({ query: "" });
    expect(out).toMatch(/query|must be|non-empty/i);
  });

  it("applies default limit of 20 when not provided", async () => {
    const searchFn = vi.fn().mockResolvedValue({ ok: true, data: [], backend: "mcp", durationMs: 1 });
    const client = mockClient({ search: searchFn });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_search")!;
    await tool.handler({ query: "test" });
    expect(searchFn).toHaveBeenCalledWith("test", { limit: 20 });
  });
});

// ── graph_query ──────────────────────────────────────────────────────

describe("graph_query handler", () => {
  it("formats NodeRef[] as a markdown list on ok:true", async () => {
    const nodes: NodeRef[] = [
      { id: "2", kind: "function", file: "src/bar.ts", line: 10, symbol: "bar" },
    ];
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ ok: true, data: nodes, backend: "mcp", durationMs: 2 }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_query")!;
    const out = await tool.handler({ pattern: "callers_of", target: "myFunc" });
    expect(out).toContain("bar");
    expect(out).toContain("src/bar.ts:10");
  });

  it("returns FallbackHint.message on ok:false", async () => {
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ ok: false, reason: "GRAPH_DISABLED", detail: "off" }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_query")!;
    const out = await tool.handler({ pattern: "callees_of", target: "myFunc" });
    expect(out).toContain("disabled");
  });

  it("rejects invalid pattern via schema validation", async () => {
    const client = mockClient();
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_query")!;
    const out = await tool.handler({ pattern: "nonsense", target: "myFunc" });
    expect(out).toMatch(/invalid|pattern|enum/i);
  });

  it("wraps string target into synthetic NodeRef", async () => {
    const queryFn = vi.fn().mockResolvedValue({ ok: true, data: [], backend: "mcp", durationMs: 1 });
    const client = mockClient({ query: queryFn });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_query")!;
    await tool.handler({ pattern: "callers_of", target: "myFunc" });
    expect(queryFn).toHaveBeenCalledWith(
      "callers_of",
      expect.objectContaining({ symbol: "myFunc", kind: "symbol" }),
    );
  });
});

// ── graph_impact ─────────────────────────────────────────────────────

describe("graph_impact handler", () => {
  it("formats ImpactReport with markdown sections on ok:true", async () => {
    const report: ImpactReport = {
      root: { id: "r", kind: "function", file: "src/root.ts", line: 1, symbol: "rootFn" },
      affected: [{ id: "a", kind: "class", file: "src/a.ts", line: 5, symbol: "AClass" }],
      testsAffected: [],
    };
    const client = mockClient({
      impact: vi.fn().mockResolvedValue({ ok: true, data: report, backend: "mcp", durationMs: 3 }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_impact")!;
    const out = await tool.handler({ target: "rootFn" });
    expect(out).toContain("## Impact analysis");
    expect(out).toContain("rootFn");
    expect(out).toContain("AClass");
    expect(out).toContain("_none_");
  });

  it("returns FallbackHint.message on ok:false", async () => {
    const client = mockClient({
      impact: vi.fn().mockResolvedValue({ ok: false, reason: "GRAPH_ERROR", detail: "err" }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_impact")!;
    const out = await tool.handler({ target: "foo" });
    expect(out).toContain("error");
  });

  it("rejects empty target via schema validation", async () => {
    const client = mockClient();
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_impact")!;
    const out = await tool.handler({ target: "" });
    expect(out).toMatch(/target|must be|non-empty/i);
  });
});

// ── graph_review_context ──────────────────────────────────────────────

describe("graph_review_context handler", () => {
  it("returns string data from GraphClient on ok:true", async () => {
    const mockContext = "```typescript\nfunction foo() { return 1; }\n```";
    const client = mockClient({
      reviewContext: vi.fn().mockResolvedValue({ ok: true, data: mockContext, backend: "mcp", durationMs: 4 }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_review_context")!;
    const nodeArg = { id: "1", kind: "function", file: "src/f.ts", line: 1, symbol: "foo" };
    const out = await tool.handler({ nodes: [nodeArg] });
    expect(out).toContain("function foo");
  });

  it("returns FallbackHint.message on ok:false", async () => {
    const client = mockClient({
      reviewContext: vi.fn().mockResolvedValue({ ok: false, reason: "GRAPH_TIMEOUT", detail: "slow" }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_review_context")!;
    const nodeArg = { id: "1", kind: "function", file: "src/f.ts", line: 1, symbol: "foo" };
    const out = await tool.handler({ nodes: [nodeArg] });
    expect(out).toContain("timed out");
  });

  it("rejects empty nodes array via schema validation", async () => {
    const client = mockClient();
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_review_context")!;
    const out = await tool.handler({ nodes: [] });
    expect(out).toMatch(/nodes|non-empty|min/i);
  });
});

// ── graph_overview ────────────────────────────────────────────────────

describe("graph_overview handler", () => {
  it("returns string overview on ok:true", async () => {
    const mockOverview = "# Architecture\n\nModules: src/mcp, src/graph, src/orchestrator";
    const client = mockClient({
      overview: vi.fn().mockResolvedValue({ ok: true, data: mockOverview, backend: "mcp", durationMs: 6 }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_overview")!;
    const out = await tool.handler({});
    expect(out).toContain("Architecture");
  });

  it("returns FallbackHint.message on ok:false", async () => {
    const client = mockClient({
      overview: vi.fn().mockResolvedValue({ ok: false, reason: "GRAPH_STALE", detail: "stale" }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_overview")!;
    const out = await tool.handler({});
    expect(out).toContain("stale");
  });

  it("truncates large overview to exactly MAX_OUTPUT_CHARS", async () => {
    const hugeData = "x".repeat(200_000);
    const client = mockClient({
      overview: vi.fn().mockResolvedValue({ ok: true, data: hugeData, backend: "mcp", durationMs: 1 }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_overview")!;
    const out = await tool.handler({});
    expect(out.length).toBe(100_000);
    expect(out.endsWith("...[truncated due to MAX_OUTPUT_CHARS]")).toBe(true);
  });
});

// ── graph_changes ─────────────────────────────────────────────────────

describe("graph_changes handler", () => {
  it("formats NodeRef[] as a markdown list on ok:true", async () => {
    const nodes: NodeRef[] = [
      { id: "c1", kind: "module", file: "src/changed.ts", line: 0, symbol: "changed" },
    ];
    const client = mockClient({
      changes: vi.fn().mockResolvedValue({ ok: true, data: nodes, backend: "mcp", durationMs: 2 }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_changes")!;
    const out = await tool.handler({ since: "HEAD~3" });
    expect(out).toContain("changed");
    expect(out).toContain("src/changed.ts");
  });

  it("returns FallbackHint.message on ok:false", async () => {
    const client = mockClient({
      changes: vi.fn().mockResolvedValue({ ok: false, reason: "GRAPH_UNAVAILABLE", detail: "down" }),
    });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_changes")!;
    const out = await tool.handler({});
    expect(out).toContain("unavailable");
  });

  it("calls changes with undefined when since not provided", async () => {
    const changesFn = vi.fn().mockResolvedValue({ ok: true, data: [], backend: "mcp", durationMs: 1 });
    const client = mockClient({ changes: changesFn });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_changes")!;
    await tool.handler({});
    expect(changesFn).toHaveBeenCalledWith(undefined);
  });

  it("calls changes with the provided since value", async () => {
    const changesFn = vi.fn().mockResolvedValue({ ok: true, data: [], backend: "mcp", durationMs: 1 });
    const client = mockClient({ changes: changesFn });
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const tool = tools.find((t) => t.name === "graph_changes")!;
    await tool.handler({ since: "abc123" });
    expect(changesFn).toHaveBeenCalledWith("abc123");
  });
});

// ── Tool factory structure ─────────────────────────────────────────────

describe("createGraphTools factory", () => {
  it("returns exactly 6 tools", () => {
    const client = mockClient();
    const tools = createGraphTools({ client, fallback: makeFallback() });
    expect(tools).toHaveLength(6);
  });

  it("returns tools with the expected names", () => {
    const client = mockClient();
    const tools = createGraphTools({ client, fallback: makeFallback() });
    const names = tools.map((t) => t.name);
    expect(names).toContain("graph_search");
    expect(names).toContain("graph_query");
    expect(names).toContain("graph_impact");
    expect(names).toContain("graph_review_context");
    expect(names).toContain("graph_overview");
    expect(names).toContain("graph_changes");
  });

  it("each tool has name, description, inputSchema, and handler", () => {
    const client = mockClient();
    const tools = createGraphTools({ client, fallback: makeFallback() });
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(20);
      expect(typeof tool.inputSchema).toBe("object");
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.handler).toBe("function");
    }
  });
});
