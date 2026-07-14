import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphClient } from "../../src/graph/client.js";
import { GraphFallback } from "../../src/graph/fallback.js";
import type { TokensaveMcpClient } from "../../src/graph/mcp-client.js";
import type { GraphArtifactStore } from "../../src/graph/artifact-store.js";
import type { IncidentLog } from "../../src/graph/incidents.js";
import type { GraphSection } from "../../src/graph/types.js";

// ── Test helpers ────────────────────────────────────────────────────

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bober-graph-client-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeMockMcp(opts: {
  callImpl?: (tool: string, params: unknown) => Promise<unknown>;
  health?: "starting" | "ready" | "restarting" | "broken";
} = {}): TokensaveMcpClient {
  return {
    call: vi.fn().mockImplementation(opts.callImpl ?? (async () => [])),
    health: vi.fn().mockReturnValue(opts.health ?? "ready"),
    start: vi.fn(),
    stop: vi.fn(),
    childPid: 12345,
  } as unknown as TokensaveMcpClient;
}

function makeMockStore(stale: boolean): GraphArtifactStore {
  return {
    staleness: vi.fn().mockResolvedValue(
      stale
        ? { stale: true, reason: "HEAD_DIFFERS", detail: "sha differs" }
        : { stale: false },
    ),
    readManifest: vi.fn(),
    writeManifest: vi.fn(),
    ensureLayout: vi.fn(),
  } as unknown as GraphArtifactStore;
}

function makeMockIncidents(): IncidentLog {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as IncidentLog;
}

function makeConfig(enabled = true): GraphSection {
  return {
    enabled,
    queryTimeoutMs: 5000,
    tokensavePath: "tokensave",
    autoSync: false,
    languageTier: "tier-1",
    manifestPath: ".bober/graph/manifest.json",
    syncTimeoutMs: 30000,
    debounceMs: 500,
    hookQueueMax: 10,
    maxEngineRssMb: 512,
  } as unknown as GraphSection;
}

function makeClient(
  mcp: TokensaveMcpClient,
  stale = false,
  enabled = true,
  incidents?: IncidentLog,
): GraphClient {
  return new GraphClient(
    tmp,
    mcp,
    makeMockStore(stale),
    new GraphFallback("dual"),
    incidents ?? makeMockIncidents(),
    makeConfig(enabled),
  );
}

// ── Happy path ──────────────────────────────────────────────────────

describe("GraphClient happy path", () => {
  it("search returns ok:true with backend='mcp' and numeric durationMs", async () => {
    // Raw tokensave_search 6.1.1 row: name→symbol, signature→snippet renames happen in adapter
    const rawRow = {
      file: "src/foo.ts",
      id: "function:1",
      kind: "function",
      line: 1,
      name: "foo",
      score: 0.9,
      signature: "function foo()",
    };
    const mcp = makeMockMcp({ callImpl: async () => [rawRow] });
    const client = makeClient(mcp);

    const r = await client.search("foo");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backend).toBe("mcp");
      expect(typeof r.durationMs).toBe("number");
      expect(r.stale).toBeUndefined();
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.node.file).toBe("src/foo.ts");
      // Verify name→symbol rename
      expect(r.data[0]!.node.symbol).toBe("foo");
      // Verify signature→snippet rename
      expect(r.data[0]!.snippet).toBe("function foo()");
    }
  });

  it("search with unknown kind coerces to 'symbol'", async () => {
    const rawRow = {
      file: "src/foo.ts",
      id: "method:1",
      kind: "method", // 6.1.1 emits 'method' which is NOT in the NodeRef.kind union
      line: 1,
      name: "bar",
      score: 0.5,
      signature: "bar()",
    };
    const mcp = makeMockMcp({ callImpl: async () => [rawRow] });
    const client = makeClient(mcp);
    const r = await client.search("bar");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data[0]!.node.kind).toBe("symbol");
    }
  });

  it("overview returns ok:true with JSON-stringified module_api data", async () => {
    // Raw tokensave_module_api result (JSON object, NOT a string)
    const rawModuleApi = {
      path: "src",
      public_symbol_count: 3,
      symbols: [
        { file: "src/graph/client.ts", id: "class:1", kind: "class", line: 46, name: "GraphClient", signature: "class GraphClient" },
      ],
    };
    const mcp = makeMockMcp({ callImpl: async () => rawModuleApi });
    const client = makeClient(mcp);

    const r = await client.overview();
    expect(r.ok).toBe(true);
    if (r.ok) {
      // overview() stringifies the JSON object
      expect(typeof r.data).toBe("string");
      expect(r.data).toContain("GraphClient");
      expect(r.backend).toBe("mcp");
    }
  });

  it("changes returns ok:true with NodeRef[] adapted from symbols_in_changed_files", async () => {
    // Raw tokensave_changelog result
    const rawChangelog = {
      changed_file_count: 1,
      changed_files: ["src/a.ts"],
      files_not_indexed: [],
      from_ref: "abc123",
      symbols_in_changed_files: [
        { file: "src/a.ts", id: "function:a", kind: "function", line: 1, name: "a", signature: "function a()" },
      ],
    };
    const mcp = makeMockMcp({ callImpl: async () => rawChangelog });
    const client = makeClient(mcp);
    const r = await client.changes("abc123");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.symbol).toBe("a");
      expect(r.data[0]!.file).toBe("src/a.ts");
    }
  });

  it("query(callers_of) returns ok:true with NodeRef[] adapted from tokensave_callers rows", async () => {
    const target = { id: "function:t", kind: "function" as const, file: "src/t.ts", line: 1, symbol: "t" };
    // Raw tokensave_callers 6.1.1 rows: node_id→id, name→symbol renames in adapter
    const mcp = makeMockMcp({
      callImpl: async () => [
        { edge_kind: "calls", file: "src/r.ts", kind: "method", line: 5, name: "r", node_id: "method:9" },
      ],
    });
    const client = makeClient(mcp);
    const r = await client.query("callers_of", target);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      // Verify node_id→id and name→symbol renames
      expect(r.data[0]!.id).toBe("method:9");
      expect(r.data[0]!.symbol).toBe("r");
      // 'method' kind coerced to 'symbol'
      expect(r.data[0]!.kind).toBe("symbol");
    }
  });

  it("query(callees_of) returns ok:true with NodeRef[] adapted from tokensave_callees rows", async () => {
    const target = { id: "function:t", kind: "function" as const, file: "src/t.ts", line: 1, symbol: "t" };
    const mcp = makeMockMcp({
      callImpl: async () => [
        { edge_kind: "calls", file: "src/b.ts", kind: "function", line: 10, name: "b", node_id: "function:b1", dispatch_via_trait: false },
      ],
    });
    const client = makeClient(mcp);
    const r = await client.query("callees_of", target);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.id).toBe("function:b1");
      expect(r.data[0]!.symbol).toBe("b");
    }
  });

  it("query(imports_of) returns ok:true with synthetic file NodeRefs from file_dependents", async () => {
    const target = { id: "module:t", kind: "module" as const, file: "src/graph/types.ts", line: 0, symbol: "types" };
    // Raw tokensave_file_dependents result
    const mcp = makeMockMcp({
      callImpl: async () => ({
        count: 2,
        dependents: ["src/graph/client.ts", "src/mcp/tools/graph.ts"],
        file: "src/graph/types.ts",
      }),
    });
    const client = makeClient(mcp);
    const r = await client.query("imports_of", target);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(2);
      expect(r.data[0]!.kind).toBe("module");
      expect(r.data[0]!.file).toBe("src/graph/client.ts");
    }
  });

  it("query(tests_for) returns ok:true with test file NodeRefs from test_files", async () => {
    const target = { id: "class:gc", kind: "class" as const, file: "src/graph/client.ts", line: 0, symbol: "GraphClient" };
    // Raw tokensave_test_map result
    const mcp = makeMockMcp({
      callImpl: async () => ({
        coverage: [],
        covered_symbols: 0,
        test_files: ["tests/graph/client.test.ts"],
        uncovered: [],
      }),
    });
    const client = makeClient(mcp);
    const r = await client.query("tests_for", target);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.file).toBe("tests/graph/client.test.ts");
      expect(r.data[0]!.kind).toBe("module");
    }
  });

  it("impact returns ok:true with ImpactReport built from tokensave_impact nodes array", async () => {
    const root = { id: "class:root", kind: "class" as const, file: "src/root.ts", line: 1, symbol: "Root" };
    // Raw tokensave_impact result: nodes array (first entry = root)
    const mcp = makeMockMcp({
      callImpl: async () => ({
        node_count: 2,
        edge_count: 1,
        nodes: [
          { file: "src/root.ts", id: "class:root", kind: "class", line: 1, name: "Root" },
          { file: "src/a.ts", id: "function:a", kind: "function", line: 2, name: "a" },
        ],
      }),
    });
    const client = makeClient(mcp);
    const r = await client.impact(root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.affected.length).toBe(1);
      expect(r.data.affected[0]!.symbol).toBe("a");
      expect(r.data.root.symbol).toBe("Root");
      expect(r.data.testsAffected.length).toBe(0);
    }
  });

  it("impact separates test files into testsAffected", async () => {
    const target = "class:gc";
    const mcp = makeMockMcp({
      callImpl: async () => ({
        node_count: 3,
        edge_count: 2,
        nodes: [
          { file: "src/graph/client.ts", id: "class:gc", kind: "class", line: 1, name: "GraphClient" },
          { file: "src/a.ts", id: "function:a", kind: "function", line: 2, name: "a" },
          { file: "tests/graph/client.test.ts", id: "module:test", kind: "module", line: 0, name: "client.test" },
        ],
      }),
    });
    const client = makeClient(mcp);
    const r = await client.impact(target);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.affected.length).toBe(1);
      expect(r.data.testsAffected.length).toBe(1);
      expect(r.data.testsAffected[0]!.file).toContain("test");
    }
  });

  it("reviewContext returns ok:true with raw markdown string from tokensave_context", async () => {
    // tokensave_context returns plain markdown (not JSON) — unwrap returns it verbatim
    const mcp = makeMockMcp({ callImpl: async () => "## Code Context\n**Query:** foo\n..." });
    const client = makeClient(mcp);
    const nodes = [{ id: "1", kind: "function" as const, file: "src/foo.ts", line: 1, symbol: "foo" }];
    const r = await client.reviewContext(nodes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toContain("Code Context");
  });
});

// ── Failure reasons ──────────────────────────────────────────────────

describe("GraphClient failure reasons", () => {
  it("GRAPH_DISABLED when config.enabled=false — does not call mcpClient", async () => {
    const mcp = makeMockMcp();
    const client = makeClient(mcp, false, false);
    const r = await client.search("foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("GRAPH_DISABLED");
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it("GRAPH_UNAVAILABLE when engine health is 'broken' — does not call mcpClient", async () => {
    const mcp = makeMockMcp({ health: "broken" });
    const client = makeClient(mcp);
    const r = await client.search("foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("GRAPH_UNAVAILABLE");
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it("GRAPH_UNAVAILABLE when engine health is 'restarting' — does not call mcpClient", async () => {
    const mcp = makeMockMcp({ health: "restarting" });
    const client = makeClient(mcp);
    const r = await client.search("foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("GRAPH_UNAVAILABLE");
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it("GRAPH_TIMEOUT propagates from mcp call with correct detail", async () => {
    const err = Object.assign(new Error("timeout"), {
      reason: "GRAPH_TIMEOUT",
      detail: "tool semantic_search_nodes timed out",
    });
    const mcp = makeMockMcp({ callImpl: async () => { throw err; } });
    const client = makeClient(mcp);
    const r = await client.search("foo");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("GRAPH_TIMEOUT");
      expect(r.detail).toBe("tool semantic_search_nodes timed out");
    }
  });

  it("GRAPH_ERROR returned when err.reason is unknown (plain Error)", async () => {
    const mcp = makeMockMcp({ callImpl: async () => { throw new Error("oops"); } });
    const client = makeClient(mcp);
    const r = await client.search("foo");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("GRAPH_ERROR");
      expect(r.detail).toBe("oops");
    }
  });

  it("GRAPH_UNAVAILABLE propagates from mcp call", async () => {
    const err = Object.assign(new Error("unavailable"), {
      reason: "GRAPH_UNAVAILABLE",
      detail: "engine breaker tripped",
    });
    const mcp = makeMockMcp({ callImpl: async () => { throw err; } });
    const client = makeClient(mcp);
    const r = await client.search("foo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("GRAPH_UNAVAILABLE");
  });
});

// ── Sandbox post-filter ──────────────────────────────────────────────

describe("GraphClient sandbox post-filter", () => {
  it("drops NodeRefs with files outside projectRoot, logs incident", async () => {
    const incidents = makeMockIncidents();
    const mcp = makeMockMcp({
      // RAW tokensave_search 6.1.1 rows — adapter builds SearchHit, then keepNode filters
      callImpl: async () => [
        { file: "/etc/passwd", id: "x", kind: "function", line: 1, name: "evil", score: 1, signature: "" },
        { file: "src/foo.ts", id: "y", kind: "function", line: 1, name: "foo", score: 0.5, signature: "" },
      ],
    });
    const client = new GraphClient(
      tmp,
      mcp,
      makeMockStore(false),
      new GraphFallback("dual"),
      incidents,
      makeConfig(),
    );
    const r = await client.search("anything");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.node.file).toBe("src/foo.ts");
    }
    // wait one microtask for void this.logSandboxDrop(...) to fire
    await new Promise((res) => setTimeout(res, 0));
    expect(incidents.append).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sandbox-drop", file: "/etc/passwd" }),
    );
  });

  it("drops NodeRef with relative path escaping projectRoot (../../etc/passwd)", async () => {
    const incidents = makeMockIncidents();
    const mcp = makeMockMcp({
      // RAW tokensave_search 6.1.1 rows
      callImpl: async () => [
        { file: "../../etc/passwd", id: "x", kind: "function", line: 1, name: "evil", score: 1, signature: "" },
        { file: "src/ok.ts", id: "y", kind: "function", line: 1, name: "ok", score: 0.5, signature: "" },
      ],
    });
    const client = new GraphClient(
      tmp,
      mcp,
      makeMockStore(false),
      new GraphFallback("dual"),
      incidents,
      makeConfig(),
    );
    const r = await client.search("anything");
    if (r.ok) {
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.node.file).toBe("src/ok.ts");
    }
    await new Promise((res) => setTimeout(res, 0));
    expect(incidents.append).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sandbox-drop", file: "../../etc/passwd" }),
    );
  });

  it("drops SearchHit with null file (buggy upstream response) without crashing", async () => {
    const incidents = makeMockIncidents();
    const mcp = makeMockMcp({
      // RAW tokensave_search row with null file — adapter will build SearchHit with null file,
      // then keepNode(h.node, "search") drops it because node.file is falsy
      callImpl: async () => [
        { file: null as unknown as string, id: "x", kind: "function", line: 1, name: "x", score: 0.5, signature: "" },
      ],
    });
    const client = new GraphClient(
      tmp,
      mcp,
      makeMockStore(false),
      new GraphFallback("dual"),
      incidents,
      makeConfig(),
    );
    const r = await client.search("anything");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.length).toBe(0);
    await new Promise((res) => setTimeout(res, 0));
    expect(incidents.append).toHaveBeenCalledWith(
      expect.objectContaining({ event: "sandbox-drop", file: "<null>" }),
    );
  });

  it("drops SearchHit with undefined file without crashing", async () => {
    const incidents = makeMockIncidents();
    const mcp = makeMockMcp({
      callImpl: async () => [
        { file: undefined as unknown as string, id: "x", kind: "function", line: 1, name: "x", score: 0.5, signature: "" },
      ],
    });
    const client = new GraphClient(
      tmp,
      mcp,
      makeMockStore(false),
      new GraphFallback("dual"),
      incidents,
      makeConfig(),
    );
    const r = await client.search("anything");
    if (r.ok) expect(r.data.length).toBe(0);
  });
});

// ── Prefetch ──────────────────────────────────────────────────────────

describe("GraphClient.prefetch", () => {
  it("empty input returns {} without calling mcpClient", async () => {
    const mcp = makeMockMcp();
    const client = makeClient(mcp);
    const result = await client.prefetch([]);
    expect(result).toEqual({});
    expect(mcp.call).not.toHaveBeenCalled();
  });

  it("one query throws — batch still returns full Record with ok:false for the failure", async () => {
    let callCount = 0;
    const mcp = makeMockMcp({
      callImpl: async () => {
        callCount++;
        if (callCount === 2) {
          throw Object.assign(new Error("x"), { reason: "GRAPH_ERROR", detail: "simulated failure" });
        }
        return [];
      },
    });
    const client = makeClient(mcp);
    const out = await client.prefetch([
      { key: "a", op: "search", args: { q: "x" } },
      { key: "b", op: "search", args: { q: "y" } },
      { key: "c", op: "search", args: { q: "z" } },
    ]);
    expect(Object.keys(out).sort()).toEqual(["a", "b", "c"]);
    expect(out["a"]!.ok).toBe(true);
    expect(out["b"]!.ok).toBe(false);
    if (!out["b"]!.ok) expect(out["b"]!.reason).toBe("GRAPH_ERROR");
    expect(out["c"]!.ok).toBe(true);
  });

  it("all ops dispatch correctly without throwing", async () => {
    const target = { id: "function:t", kind: "function" as const, file: "src/t.ts", line: 1, symbol: "t" };
    const mcp = makeMockMcp({
      // Return RAW 6.1.1 shapes for each tokensave_* tool (not pre-adapted)
      callImpl: async (tool) => {
        if (tool === "tokensave_module_api") {
          return { path: "src", public_symbol_count: 0, symbols: [] };
        }
        if (tool === "tokensave_context") return "## Code Context\nreview text";
        if (tool === "tokensave_impact") {
          return {
            node_count: 1,
            edge_count: 0,
            nodes: [{ file: "src/t.ts", id: "function:t", kind: "function", line: 1, name: "t" }],
          };
        }
        if (tool === "tokensave_callers") return [];
        if (tool === "tokensave_changelog") {
          return { changed_file_count: 0, changed_files: [], files_not_indexed: [], from_ref: "abc", symbols_in_changed_files: [] };
        }
        // tokensave_search and others return empty array
        return [];
      },
    });
    const client = makeClient(mcp);
    const out = await client.prefetch([
      { key: "s", op: "search", args: { q: "foo" } },
      { key: "q", op: "query", args: { pattern: "callers_of", target } },
      { key: "i", op: "impact", args: { target } },
      { key: "r", op: "reviewContext", args: { nodes: [target] } },
      { key: "o", op: "overview", args: {} },
      { key: "c", op: "changes", args: { since: "abc" } },
    ]);
    expect(Object.keys(out).sort()).toEqual(["c", "i", "o", "q", "r", "s"]);
    for (const key of Object.keys(out)) {
      expect(out[key]!.ok).toBe(true);
    }
  });
});

// ── Staleness flag ────────────────────────────────────────────────────

describe("GraphClient staleness flag", () => {
  it("ok:true result carries stale:true when manifest is stale", async () => {
    const mcp = makeMockMcp({ callImpl: async () => [] });
    const client = makeClient(mcp, true);
    const r = await client.search("x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stale).toBe(true);
  });

  it("ok:true result has no stale flag when manifest is fresh", async () => {
    const mcp = makeMockMcp({ callImpl: async () => [] });
    const client = makeClient(mcp, false);
    const r = await client.search("x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stale).toBeUndefined();
  });

  it("staleness is checked once per session (store.staleness called once across multiple queries)", async () => {
    const store = makeMockStore(true);
    const mcp = makeMockMcp({ callImpl: async () => [] });
    const client = new GraphClient(
      tmp,
      mcp,
      store,
      new GraphFallback("dual"),
      makeMockIncidents(),
      makeConfig(),
    );
    await client.search("x");
    await client.search("y");
    await client.search("z");
    expect(store.staleness).toHaveBeenCalledTimes(1);
  });

  it("markFresh() clears stale flag for subsequent calls", async () => {
    const mcp = makeMockMcp({ callImpl: async () => [] });
    const client = makeClient(mcp, true);

    const r1 = await client.search("x");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.stale).toBe(true);

    client.markFresh();

    const r2 = await client.search("x");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.stale).toBeUndefined();
  });
});

// ── Engine health edge cases ──────────────────────────────────────────

describe("GraphClient with graph.enabled=false", () => {
  it("all methods return GRAPH_DISABLED without calling mcpClient", async () => {
    const mcp = makeMockMcp();
    const client = makeClient(mcp, false, false);

    const results = await Promise.all([
      client.search("foo"),
      client.overview(),
      client.changes(),
      client.prefetch([{ key: "k", op: "overview", args: {} }]),
    ]);

    // search, overview, changes all GRAPH_DISABLED
    for (const r of results.slice(0, 3)) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("GRAPH_DISABLED");
    }
    // prefetch result for key "k" is also GRAPH_DISABLED
    const prefetchResult = results[3] as Record<string, { ok: boolean; reason?: string }>;
    expect(prefetchResult["k"]!.ok).toBe(false);
    expect(prefetchResult["k"]!.reason).toBe("GRAPH_DISABLED");

    expect(mcp.call).not.toHaveBeenCalled();
  });
});

describe("GraphClient with engineHealth='broken'", () => {
  it("every method returns GRAPH_UNAVAILABLE", async () => {
    const mcp = makeMockMcp({ health: "broken" });
    const client = makeClient(mcp);

    const r1 = await client.search("foo");
    const r2 = await client.overview();
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("GRAPH_UNAVAILABLE");
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("GRAPH_UNAVAILABLE");

    expect(mcp.call).not.toHaveBeenCalled();
  });
});
