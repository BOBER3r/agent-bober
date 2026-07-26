import { describe, it, expect } from "vitest";
import { TokensaveBackend } from "../../../src/graph/backends/tokensave-backend.js";
import type { NodeRef } from "../../../src/graph/types.js";

// ── TokensaveBackend — pure adapter, no mcp/fs mocks needed ────────────

describe("TokensaveBackend", () => {
  const backend = new TokensaveBackend();

  it("has id 'tokensave'", () => {
    expect(backend.id).toBe("tokensave");
  });

  // ── searchPlan ──────────────────────────────────────────────────────

  describe("searchPlan", () => {
    it("uses tokensave_search and adapts name→symbol, signature→snippet", () => {
      const plan = backend.searchPlan("foo");
      expect(plan.tool).toBe("tokensave_search");
      const rawRow = {
        file: "src/foo.ts",
        id: "function:1",
        kind: "function",
        line: 1,
        name: "foo",
        score: 0.9,
        signature: "function foo()",
      };
      const hits = plan.narrow([rawRow]);
      expect(hits.length).toBe(1);
      expect(hits[0]!.node.symbol).toBe("foo");
      expect(hits[0]!.node.file).toBe("src/foo.ts");
      expect(hits[0]!.snippet).toBe("function foo()");
      expect(hits[0]!.score).toBe(0.9);
    });

    it("coerces an unknown kind to 'symbol'", () => {
      const plan = backend.searchPlan("bar");
      const rawRow = {
        file: "src/foo.ts",
        id: "method:1",
        kind: "method", // not in the NodeRef.kind union
        line: 1,
        name: "bar",
        score: 0.5,
        signature: "bar()",
      };
      const hits = plan.narrow([rawRow]);
      expect(hits[0]!.node.kind).toBe("symbol");
    });

    it("includes limit param only when provided", () => {
      expect(backend.searchPlan("x").params).toEqual({ query: "x" });
      expect(backend.searchPlan("x", { limit: 5 }).params).toEqual({
        query: "x",
        limit: 5,
      });
    });

    it("post-filters by opts.kind", () => {
      const plan = backend.searchPlan("x", { kind: "class" });
      const rows = [
        { file: "a.ts", id: "1", kind: "class", line: 1, name: "A", score: 1 },
        { file: "b.ts", id: "2", kind: "function", line: 1, name: "B", score: 1 },
      ];
      const hits = plan.narrow(rows);
      expect(hits.length).toBe(1);
      expect(hits[0]!.node.symbol).toBe("A");
    });
  });

  // ── queryPlan ───────────────────────────────────────────────────────

  describe("queryPlan", () => {
    const target: NodeRef = { id: "function:t", kind: "function", file: "src/t.ts", line: 1, symbol: "t" };

    it("callers_of uses tokensave_callers and maps node_id→id, name→symbol", () => {
      const plan = backend.queryPlan("callers_of", target);
      expect(plan.tool).toBe("tokensave_callers");
      expect(plan.params).toEqual({ node_id: "function:t" });
      const rows = [
        { edge_kind: "calls", file: "src/r.ts", kind: "method", line: 5, name: "r", node_id: "method:9" },
      ];
      const nodes = plan.narrow(rows);
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.id).toBe("method:9");
      expect(nodes[0]!.symbol).toBe("r");
      expect(nodes[0]!.kind).toBe("symbol");
    });

    it("callees_of uses tokensave_callees", () => {
      const plan = backend.queryPlan("callees_of", target);
      expect(plan.tool).toBe("tokensave_callees");
      const rows = [
        { edge_kind: "calls", file: "src/b.ts", kind: "function", line: 10, name: "b", node_id: "function:b1" },
      ];
      const nodes = plan.narrow(rows);
      expect(nodes[0]!.id).toBe("function:b1");
      expect(nodes[0]!.symbol).toBe("b");
    });

    it("imports_of uses tokensave_file_dependents and builds synthetic module NodeRefs", () => {
      const plan = backend.queryPlan("imports_of", { ...target, file: "src/graph/types.ts" });
      expect(plan.tool).toBe("tokensave_file_dependents");
      expect(plan.params).toEqual({ file: "src/graph/types.ts" });
      const raw = {
        count: 2,
        dependents: ["src/graph/client.ts", "src/mcp/tools/graph.ts"],
        file: "src/graph/types.ts",
      };
      const nodes = plan.narrow(raw);
      expect(nodes.length).toBe(2);
      expect(nodes[0]!.kind).toBe("module");
      expect(nodes[0]!.file).toBe("src/graph/client.ts");
      expect(nodes[0]!.id).toBe("src/graph/client.ts");
    });

    it("tests_for uses tokensave_test_map and prefers test_files over uncovered", () => {
      const plan = backend.queryPlan("tests_for", target);
      expect(plan.tool).toBe("tokensave_test_map");
      const raw = {
        coverage: [],
        covered_symbols: 0,
        test_files: ["tests/graph/client.test.ts"],
        uncovered: [],
      };
      const nodes = plan.narrow(raw);
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.file).toBe("tests/graph/client.test.ts");
      expect(nodes[0]!.kind).toBe("module");
    });

    it("tests_for falls back to uncovered rows when test_files is empty", () => {
      const plan = backend.queryPlan("tests_for", target);
      const raw = {
        coverage: [],
        covered_symbols: 0,
        test_files: [],
        uncovered: [{ file: "src/graph/client.ts", id: "class:gc", line: 1, name: "GraphClient" }],
      };
      const nodes = plan.narrow(raw);
      expect(nodes.length).toBe(1);
      expect(nodes[0]!.symbol).toBe("GraphClient");
      expect(nodes[0]!.file).toBe("src/graph/client.ts");
    });
  });

  // ── impactPlan ──────────────────────────────────────────────────────

  describe("impactPlan", () => {
    it("uses tokensave_impact and partitions root/affected/testsAffected", () => {
      const plan = backend.impactPlan({ id: "class:root", kind: "class", file: "src/root.ts", line: 1, symbol: "Root" });
      expect(plan.tool).toBe("tokensave_impact");
      expect(plan.params).toEqual({ node_id: "class:root" });
      const raw = {
        node_count: 3,
        edge_count: 2,
        nodes: [
          { file: "src/root.ts", id: "class:root", kind: "class", line: 1, name: "Root" },
          { file: "src/a.ts", id: "function:a", kind: "function", line: 2, name: "a" },
          { file: "tests/graph/client.test.ts", id: "module:test", kind: "module", line: 0, name: "client.test" },
        ],
      };
      const report = plan.narrow(raw);
      expect(report.root.symbol).toBe("Root");
      expect(report.affected.length).toBe(1);
      expect(report.affected[0]!.symbol).toBe("a");
      expect(report.testsAffected.length).toBe(1);
      expect(report.testsAffected[0]!.file).toContain("test");
    });

    it("accepts a string target and synthesizes a root when nodes[] is empty", () => {
      const plan = backend.impactPlan("class:gc");
      expect(plan.params).toEqual({ node_id: "class:gc" });
      const raw = { node_count: 0, edge_count: 0, nodes: [] };
      const report = plan.narrow(raw);
      expect(report.root.id).toBe("class:gc");
      expect(report.root.symbol).toBe("class:gc");
      expect(report.affected.length).toBe(0);
      expect(report.testsAffected.length).toBe(0);
    });
  });

  // ── reviewContextPlan ───────────────────────────────────────────────

  it("reviewContextPlan uses tokensave_context with a joined task and passes the raw string through", () => {
    const nodes: NodeRef[] = [
      { id: "1", kind: "function", file: "src/foo.ts", line: 1, symbol: "foo" },
      { id: "2", kind: "function", file: "src/bar.ts", line: 1, symbol: "bar" },
    ];
    const plan = backend.reviewContextPlan(nodes);
    expect(plan.tool).toBe("tokensave_context");
    expect(plan.params).toEqual({ task: "foo, bar" });
    expect(plan.narrow("## Code Context\n...")).toBe("## Code Context\n...");
  });

  // ── overviewPlan ────────────────────────────────────────────────────

  it("overviewPlan uses tokensave_module_api and JSON.stringifies the result", () => {
    const plan = backend.overviewPlan();
    expect(plan.tool).toBe("tokensave_module_api");
    expect(plan.params).toEqual({ path: "src" });
    const raw = {
      path: "src",
      public_symbol_count: 1,
      symbols: [{ file: "src/graph/client.ts", id: "class:1", kind: "class", line: 46, name: "GraphClient" }],
    };
    const str = plan.narrow(raw);
    expect(typeof str).toBe("string");
    expect(str).toContain("GraphClient");
  });

  // ── changesPlan ─────────────────────────────────────────────────────

  it("changesPlan uses tokensave_changelog with default/explicit refs and maps symbols_in_changed_files", () => {
    expect(backend.changesPlan().params).toEqual({ from_ref: "HEAD~1", to_ref: "HEAD" });
    const plan = backend.changesPlan("abc123");
    expect(plan.tool).toBe("tokensave_changelog");
    expect(plan.params).toEqual({ from_ref: "abc123", to_ref: "HEAD" });
    const raw = {
      changed_file_count: 1,
      changed_files: ["src/a.ts"],
      files_not_indexed: [],
      from_ref: "abc123",
      symbols_in_changed_files: [
        { file: "src/a.ts", id: "function:a", kind: "function", line: 1, name: "a", signature: "function a()" },
      ],
    };
    const nodes = plan.narrow(raw);
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.symbol).toBe("a");
    expect(nodes[0]!.file).toBe("src/a.ts");
  });
});
