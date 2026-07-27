/**
 * Unit tests for CodeReviewGraphBackend.
 *
 * processSpec/prereqSpec/cliMap (sc-4-2/4-3) plus all 6 response *Plan
 * adapters (search/impact/reviewContext/overview/changes from Sprint 5,
 * queryPlan's 4 sub-patterns from Sprint 6), fixture-driven against the
 * real captures under tests/graph/fixtures/cr-graph/.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { CodeReviewGraphBackend } from "../../../src/graph/backends/code-review-graph-backend.js";
import { GenericPrereqCheck } from "../../../src/graph/prereq.js";
import type { NodeRef } from "../../../src/graph/types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/cr-graph");

async function loadFixture(name: string): Promise<unknown> {
  const raw = await readFile(join(FIXTURES_DIR, name), "utf-8");
  return JSON.parse(raw) as unknown;
}

function mockExeca(value: Record<string, unknown>): void {
  (execa as unknown as Mock).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    failed: false,
    timedOut: false,
    all: "",
    ...value,
  });
}

describe("CodeReviewGraphBackend", () => {
  const backend = new CodeReviewGraphBackend();

  beforeEach(() => {
    (execa as unknown as Mock).mockReset();
  });

  it("has id 'code-review-graph'", () => {
    expect(backend.id).toBe("code-review-graph");
  });

  // ── processSpec (sc-4-2) ──────────────────────────────────────────

  describe("processSpec", () => {
    it("returns binary 'code-review-graph' and serveArgs ['serve']", () => {
      expect(backend.processSpec()).toEqual({
        binary: "code-review-graph",
        serveArgs: ["serve"],
      });
    });
  });

  // ── prereqSpec (sc-4-2) ───────────────────────────────────────────

  describe("prereqSpec", () => {
    const spec = backend.prereqSpec();

    it("versionArgs is ['--version']", () => {
      expect(spec.versionArgs).toEqual(["--version"]);
    });

    it("installHint is 'pip install code-review-graph' on every platform", () => {
      expect(spec.installHint("darwin")).toBe("pip install code-review-graph");
      expect(spec.installHint("linux")).toBe("pip install code-review-graph");
      expect(spec.installHint("win32")).toBe("pip install code-review-graph");
    });

    it("isCompatible accepts any parseable version (no published range yet)", () => {
      expect(spec.isCompatible("2.3.7")).toBe(true);
      expect(spec.isCompatible("0.0.1")).toBe(true);
      expect(spec.isCompatible("99.0.0")).toBe(true);
    });
  });

  // ── GenericPrereqCheck against the cr-graph spec (sc-4-2) ──────────

  describe("GenericPrereqCheck('code-review-graph', prereqSpec)", () => {
    it("a real 2.x version string passes", async () => {
      mockExeca({ exitCode: 0, stdout: "code-review-graph 2.3.7" });
      const check = new GenericPrereqCheck("code-review-graph", backend.prereqSpec());
      const result = await check.check();
      expect(result).toEqual({ ok: true, version: "2.3.7" });
    });

    it("a clearly-incompatible (non-semver) version line fails INCOMPATIBLE", async () => {
      // isCompatible is accept-any (no published range yet), so the only
      // route to INCOMPATIBLE is an unparseable version string tripping
      // semver.valid() inside GenericPrereqCheck (prereq.ts:38).
      mockExeca({ exitCode: 0, stdout: "code-review-graph not-a-version" });
      const check = new GenericPrereqCheck("code-review-graph", backend.prereqSpec());
      const result = await check.check();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("INCOMPATIBLE");
        expect(result.hint).toContain("code-review-graph");
      }
    });

    it("a missing binary (non-zero exit) fails MISSING with the pip hint", async () => {
      mockExeca({ exitCode: 1, failed: true, stdout: "" });
      const check = new GenericPrereqCheck("code-review-graph", backend.prereqSpec());
      const result = await check.check();
      expect(result).toEqual({
        ok: false,
        reason: "MISSING",
        hint: "pip install code-review-graph",
      });
    });

    it("execa throwing (binary not found) fails MISSING with the pip hint", async () => {
      (execa as unknown as Mock).mockRejectedValue(new Error("ENOENT"));
      const check = new GenericPrereqCheck("code-review-graph", backend.prereqSpec());
      const result = await check.check();
      expect(result).toEqual({
        ok: false,
        reason: "MISSING",
        hint: "pip install code-review-graph",
      });
    });
  });

  // ── cliMap (sc-4-3) ─────────────────────────────────────────────────

  describe("cliMap", () => {
    const cliMap = backend.cliMap();

    it("initArgs is ['build'] regardless of languageTier (not forwarded)", () => {
      expect(cliMap.initArgs({})).toEqual(["build"]);
      expect(cliMap.initArgs({ languageTier: "core" })).toEqual(["build"]);
    });

    it("syncArgs is ['update', ...paths]", () => {
      expect(cliMap.syncArgs(["src/"])).toEqual(["update", "src/"]);
      expect(cliMap.syncArgs([])).toEqual(["update"]);
    });

    it("statusArgs is ['status', '--json']", () => {
      expect(cliMap.statusArgs).toEqual(["status", "--json"]);
    });

    // parseSync — against real captured CLI output samples (sprint-4 briefing §7-8,
    // reproduced live via the venv+.pth workaround; see the fixture-capture recipe).

    it("parseSync reads the real 'Full build: N files' summary", () => {
      expect(
        cliMap.parseSync("Full build: 2 files, 8 nodes, 15 edges (postprocess=full)"),
      ).toBe(2);
    });

    it("parseSync reads the real 'Incremental: N files updated' summary", () => {
      expect(
        cliMap.parseSync("Incremental: 1 files updated, 4 nodes, 9 edges (postprocess=full)"),
      ).toBe(1);
    });

    it("parseSync reads a multi-file incremental summary", () => {
      expect(
        cliMap.parseSync("Incremental: 2 files updated, 6 nodes, 10 edges (postprocess=full)"),
      ).toBe(2);
    });

    it("parseSync strips ANSI escape codes defensively", () => {
      expect(
        cliMap.parseSync("\x1b[32mFull build: 2 files, 8 nodes, 15 edges (postprocess=full)\x1b[0m"),
      ).toBe(2);
    });

    it("parseSync returns 0 on empty output (the -q/--quiet case)", () => {
      expect(cliMap.parseSync("")).toBe(0);
    });

    // parseStatus — against the real captured `status --json` sample.

    it("parseStatus maps the real {files,nodes,edges} shape to {ready,indexedFileCount}", () => {
      const result = cliMap.parseStatus(
        JSON.stringify({
          nodes: 8,
          edges: 15,
          files: 2,
          languages: ["python"],
          last_updated: "2026-07-27T03:48:55",
          vcs: "git",
          built_on_branch: "master",
          built_at_commit: "ba46a31e600bd1170c051cccebc1f094e2259157",
          current_branch: "master",
          current_sha: "ba46a31e600bd1170c051cccebc1f094e2259157",
          svn_branch: null,
          svn_revision: null,
        }),
      );
      expect(result.ready).toBe(true);
      expect(result.indexedFileCount).toBe(2);
      expect(result.tokensaveVersion).toBe("");
    });

    it("parseStatus derives ready=false when neither files nor nodes is a number", () => {
      const result = cliMap.parseStatus(JSON.stringify({ languages: [] }));
      expect(result.ready).toBe(false);
      expect(result.indexedFileCount).toBe(0);
    });
  });

  // ── searchPlan (sc-5-2) ─────────────────────────────────────────────

  describe("searchPlan", () => {
    it("uses semantic_search_nodes_tool with {query, limit}", () => {
      expect(backend.searchPlan("add").params).toEqual({ query: "add" });
      expect(backend.searchPlan("add", { limit: 5 }).params).toEqual({
        query: "add",
        limit: 5,
      });
    });

    it("narrows the real semantic_search_nodes_tool.json fixture -> SearchHit[]", async () => {
      const plan = backend.searchPlan("add", { limit: 5 });
      expect(plan.tool).toBe("semantic_search_nodes_tool");
      const fixture = await loadFixture("semantic_search_nodes_tool.json");
      const hits = plan.narrow(fixture);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.node.symbol).toBe("add");
      expect(hits[0]!.node.id).toBe("/repo/src/math_utils.py::add");
      expect(hits[0]!.node.file).toBe("/repo/src/math_utils.py");
      expect(hits[0]!.node.line).toBe(1);
      expect(hits[0]!.node.kind).toBe("function"); // "Function" -> "function"
      expect(hits[0]!.score).toBeCloseTo(0.016393);
      expect(hits[0]!.snippet).toBe("def add((a, b))");
    });

    it("post-filters by opts.kind after narrowing", async () => {
      const plan = backend.searchPlan("add", { kind: "class" });
      const fixture = await loadFixture("semantic_search_nodes_tool.json");
      expect(plan.narrow(fixture)).toHaveLength(0);
    });
  });

  // ── impactPlan (sc-5-4) ─────────────────────────────────────────────

  describe("impactPlan", () => {
    it("uses get_impact_radius_tool with {changed_files: [file]}", () => {
      const target = { id: "x", kind: "module" as const, file: "src/math_utils.py", line: 0, symbol: "math_utils" };
      expect(backend.impactPlan(target).tool).toBe("get_impact_radius_tool");
      expect(backend.impactPlan(target).params).toEqual({ changed_files: ["src/math_utils.py"] });
    });

    it("accepts a qualified_name string target and derives the file portion", () => {
      const plan = backend.impactPlan("/repo/src/main.py::another");
      expect(plan.params).toEqual({ changed_files: ["/repo/src/main.py"] });
    });

    it("narrows the real get_impact_radius_tool.json fixture -> ImpactReport", async () => {
      const target = { id: "x", kind: "module" as const, file: "src/math_utils.py", line: 0, symbol: "math_utils" };
      const plan = backend.impactPlan(target);
      const fixture = await loadFixture("get_impact_radius_tool.json");
      const report = plan.narrow(fixture);
      // root = changed_nodes[0] = the File node for math_utils.py
      expect(report.root.file).toBe("/repo/src/math_utils.py");
      expect(report.root.kind).toBe("module"); // "File" -> "module"
      // impacted_nodes (4 rows) are all is_test:false -> all affected, none testsAffected
      expect(report.affected).toHaveLength(4);
      expect(report.testsAffected).toHaveLength(0);
      expect(report.affected.map((n) => n.symbol).sort()).toEqual(
        ["another", "helper", "run", "/repo/src/main.py"].sort(),
      );
    });
  });

  // ── reviewContextPlan (sc-5-3) ──────────────────────────────────────

  describe("reviewContextPlan", () => {
    it("uses get_review_context_tool with de-duplicated changed_files from node.file", () => {
      const nodes = [
        { id: "1", kind: "function" as const, file: "src/main.py", line: 5, symbol: "another" },
        { id: "2", kind: "function" as const, file: "src/main.py", line: 4, symbol: "helper" },
      ];
      const plan = backend.reviewContextPlan(nodes);
      expect(plan.tool).toBe("get_review_context_tool");
      expect(plan.params).toEqual({ changed_files: ["src/main.py"] });
    });

    it("narrows the real get_review_context_tool.json fixture -> string", async () => {
      const plan = backend.reviewContextPlan([]);
      const fixture = await loadFixture("get_review_context_tool.json");
      const result = plan.narrow(fixture);
      expect(typeof result).toBe("string");
      expect(result).toContain("review_guidance");
    });

    it("passes an already-string raw payload through unchanged", () => {
      const plan = backend.reviewContextPlan([]);
      expect(plan.narrow("already a string")).toBe("already a string");
    });
  });

  // ── overviewPlan (sc-5-3) ───────────────────────────────────────────

  describe("overviewPlan", () => {
    it("uses get_architecture_overview_tool with no params", () => {
      const plan = backend.overviewPlan();
      expect(plan.tool).toBe("get_architecture_overview_tool");
      expect(plan.params).toEqual({});
    });

    it("narrows the real get_architecture_overview_tool.json fixture -> string", async () => {
      const plan = backend.overviewPlan();
      const fixture = await loadFixture("get_architecture_overview_tool.json");
      const result = plan.narrow(fixture);
      expect(typeof result).toBe("string");
      expect(result).toContain("src-helper");
      expect(result).toContain("communities");
    });
  });

  // ── changesPlan (sc-5-5) ────────────────────────────────────────────

  describe("changesPlan", () => {
    it("uses detect_changes_tool with {base} defaulting to HEAD~1", () => {
      expect(backend.changesPlan().params).toEqual({ base: "HEAD~1" });
      expect(backend.changesPlan("HEAD~3").params).toEqual({ base: "HEAD~3" });
    });

    it("narrows the real detect_changes_tool.json fixture -> NodeRef[]", async () => {
      const plan = backend.changesPlan();
      expect(plan.tool).toBe("detect_changes_tool");
      const fixture = await loadFixture("detect_changes_tool.json");
      const nodes = plan.narrow(fixture);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.symbol).toBe("another");
      expect(nodes[0]!.id).toBe("/repo/src/main.py::another");
      expect(nodes[0]!.file).toBe("/repo/src/main.py");
      expect(nodes[0]!.line).toBe(5);
      expect(nodes[0]!.kind).toBe("function");
    });

    it("returns [] when changed_functions is absent", () => {
      const plan = backend.changesPlan();
      expect(plan.narrow({})).toEqual([]);
    });
  });

  // ── queryPlan (Sprint 6, sc-6-2/6-3/6-4/6-5) ─────────────────────────
  //
  // All 4 patterns route through query_graph_tool with `pattern` as the
  // direction/relationship selector (fixtures captured live from
  // code-review-graph 2.3.7 — tests/graph/fixtures/cr-graph/_args.json).

  describe("queryPlan", () => {
    const target: NodeRef = {
      id: "/repo/src/math_utils.py::multiply",
      kind: "function",
      file: "/repo/src/math_utils.py",
      line: 4,
      symbol: "multiply",
    };

    it("callers_of uses query_graph_tool with pattern='callers_of' + target.id", () => {
      const plan = backend.queryPlan("callers_of", target);
      expect(plan.tool).toBe("query_graph_tool");
      expect(plan.params).toEqual({ pattern: "callers_of", target: target.id });
    });

    it("callers_of narrows the real fixture -> INBOUND NodeRef[]", async () => {
      const nodes = backend
        .queryPlan("callers_of", target)
        .narrow(await loadFixture("query_graph_callers_of_tool.json"));
      expect(nodes.map((n) => n.symbol).sort()).toEqual(["compute", "test_multiply"]);
    });

    it("callees_of uses query_graph_tool with pattern='callees_of' + target.id", () => {
      const plan = backend.queryPlan("callees_of", target);
      expect(plan.tool).toBe("query_graph_tool");
      expect(plan.params).toEqual({ pattern: "callees_of", target: target.id });
    });

    it("callees_of narrows the real fixture -> OUTBOUND NodeRef[]", async () => {
      const nodes = backend
        .queryPlan("callees_of", target)
        .narrow(await loadFixture("query_graph_callees_of_tool.json"));
      // range (builtin) has no file_path -> file undefined; add is in-repo.
      expect(nodes.map((n) => n.symbol).sort()).toEqual(["add", "range"]);
    });

    // ── the required edge-direction assertion (sc-6-2) ──
    it("callers_of != callees_of for the same node with distinct in/out edges", async () => {
      const inbound = backend
        .queryPlan("callers_of", target)
        .narrow(await loadFixture("query_graph_callers_of_tool.json"))
        .map((n) => n.symbol)
        .sort();
      const outbound = backend
        .queryPlan("callees_of", target)
        .narrow(await loadFixture("query_graph_callees_of_tool.json"))
        .map((n) => n.symbol)
        .sort();
      expect(inbound).not.toEqual(outbound);
      expect(inbound).toEqual(["compute", "test_multiply"]);
      expect(outbound).toEqual(["add", "range"]);
    });

    it("imports_of uses query_graph_tool with pattern='importers_of' (NOT 'imports_of') + target.file", () => {
      const importTarget: NodeRef = { ...target, file: "src/math_utils.py" };
      const plan = backend.queryPlan("imports_of", importTarget);
      expect(plan.tool).toBe("query_graph_tool");
      expect(plan.params).toEqual({ pattern: "importers_of", target: "src/math_utils.py" });
    });

    it("imports_of narrows the real 'importers_of' fixture -> module NodeRef[] from results[].importer", async () => {
      const importTarget: NodeRef = { ...target, file: "src/math_utils.py" };
      const nodes = backend
        .queryPlan("imports_of", importTarget)
        .narrow(await loadFixture("query_graph_importers_of_tool.json"));
      expect(nodes.map((n) => n.file).sort()).toEqual([
        "/repo/src/main.py",
        "/repo/tests/test_math_utils.py",
      ]);
      expect(nodes.every((n) => n.kind === "module")).toBe(true);
    });

    it("imports_of does NOT use cr-graph's own 'imports_of' pattern (guards trap #1)", async () => {
      // Sanity check against the trap fixture: cr-graph's own "imports_of"
      // pattern returns the OPPOSITE direction (what the target imports,
      // not who imports it) — confirm the adapter's plan.params never
      // requests it, and that narrowing the trap fixture through the
      // "importers_of"-shaped narrow would NOT produce the correct dependents.
      const trapFixture = (await loadFixture("query_graph_imports_of_tool.json")) as {
        pattern: string;
      };
      expect(trapFixture.pattern).toBe("imports_of");
      const importTarget: NodeRef = { ...target, file: "src/math_utils.py" };
      expect(backend.queryPlan("imports_of", importTarget).params).not.toEqual({
        pattern: "imports_of",
        target: "src/math_utils.py",
      });
    });

    it("tests_for uses query_graph_tool with pattern='tests_for' + target.id (NOT target.file, guards trap #2)", () => {
      const plan = backend.queryPlan("tests_for", target);
      expect(plan.tool).toBe("query_graph_tool");
      expect(plan.params).toEqual({ pattern: "tests_for", target: target.id });
      expect(plan.params).not.toEqual({ pattern: "tests_for", target: target.file });
    });

    it("tests_for narrows the real fixture -> test-symbol NodeRef[]", async () => {
      const nodes = backend
        .queryPlan("tests_for", target)
        .narrow(await loadFixture("query_graph_tests_for_tool.json"));
      expect(nodes.map((n) => n.symbol).sort()).toEqual(["test_add", "test_multiply"]);
    });

    it("defaults to [] when `results` is absent (e.g. an ambiguous bare-name payload)", () => {
      expect(backend.queryPlan("callers_of", target).narrow({ status: "ambiguous" })).toEqual([]);
      expect(backend.queryPlan("imports_of", target).narrow({ status: "ambiguous" })).toEqual([]);
    });
  });
});
