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
    const hit = {
      node: { id: "1", kind: "function", file: "src/foo.ts", line: 1, symbol: "foo" },
      score: 0.9,
      snippet: "",
    };
    const mcp = makeMockMcp({ callImpl: async () => [hit] });
    const client = makeClient(mcp);

    const r = await client.search("foo");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.backend).toBe("mcp");
      expect(typeof r.durationMs).toBe("number");
      expect(r.stale).toBeUndefined();
      expect(r.data.length).toBe(1);
      expect(r.data[0]!.node.file).toBe("src/foo.ts");
    }
  });

  it("overview returns ok:true with string data", async () => {
    const mcp = makeMockMcp({ callImpl: async () => "arch overview text" });
    const client = makeClient(mcp);

    const r = await client.overview();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toBe("arch overview text");
      expect(r.backend).toBe("mcp");
    }
  });

  it("changes returns ok:true with filtered NodeRef[]", async () => {
    const mcp = makeMockMcp({
      callImpl: async () => [
        { id: "a", kind: "function", file: "src/a.ts", line: 1, symbol: "a" },
      ],
    });
    const client = makeClient(mcp);
    const r = await client.changes("abc123");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.length).toBe(1);
  });

  it("query returns ok:true with filtered NodeRef[]", async () => {
    const target = { id: "t", kind: "function" as const, file: "src/t.ts", line: 1, symbol: "t" };
    const mcp = makeMockMcp({
      callImpl: async () => [
        { id: "r", kind: "function", file: "src/r.ts", line: 5, symbol: "r" },
      ],
    });
    const client = makeClient(mcp);
    const r = await client.query("callers_of", target);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.length).toBe(1);
  });

  it("impact returns ok:true with filtered ImpactReport", async () => {
    const root = { id: "root", kind: "function" as const, file: "src/root.ts", line: 1, symbol: "root" };
    const mcp = makeMockMcp({
      callImpl: async () => ({
        root,
        affected: [{ id: "a", kind: "function", file: "src/a.ts", line: 2, symbol: "a" }],
        testsAffected: [],
      }),
    });
    const client = makeClient(mcp);
    const r = await client.impact(root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.affected.length).toBe(1);
    }
  });

  it("reviewContext returns ok:true with string data", async () => {
    const mcp = makeMockMcp({ callImpl: async () => "context text" });
    const client = makeClient(mcp);
    const nodes = [{ id: "1", kind: "function" as const, file: "src/foo.ts", line: 1, symbol: "foo" }];
    const r = await client.reviewContext(nodes);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe("context text");
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
      callImpl: async () => [
        { node: { id: "1", kind: "function", file: "/etc/passwd", line: 1, symbol: "evil" }, score: 1, snippet: "" },
        { node: { id: "2", kind: "function", file: "src/foo.ts", line: 1, symbol: "foo" }, score: 0.5, snippet: "" },
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
      callImpl: async () => [
        { node: { id: "1", kind: "function", file: "../../etc/passwd", line: 1, symbol: "evil" }, score: 1, snippet: "" },
        { node: { id: "2", kind: "function", file: "src/ok.ts", line: 1, symbol: "ok" }, score: 0.5, snippet: "" },
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

  it("drops NodeRefs with null file (buggy upstream response) without crashing", async () => {
    const incidents = makeMockIncidents();
    const mcp = makeMockMcp({
      callImpl: async () => [
        { node: { id: "1", kind: "function", file: null as unknown as string, line: 1, symbol: "x" }, score: 0.5, snippet: "" },
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

  it("drops NodeRefs with undefined file without crashing", async () => {
    const incidents = makeMockIncidents();
    const mcp = makeMockMcp({
      callImpl: async () => [
        { node: { id: "1", kind: "function", file: undefined as unknown as string, line: 1, symbol: "x" }, score: 0.5, snippet: "" },
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
    const target = { id: "t", kind: "function" as const, file: "src/t.ts", line: 1, symbol: "t" };
    const mcp = makeMockMcp({
      callImpl: async (tool) => {
        if (tool === "get_architecture_overview") return "overview text";
        if (tool === "get_review_context") return "review text";
        if (tool === "get_impact_radius") {
          return { root: target, affected: [], testsAffected: [] };
        }
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
