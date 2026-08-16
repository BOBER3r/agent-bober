/**
 * Regression tests for sc-3-6 (sprint-3 iteration 2 retry).
 *
 * TokensaveCli must accept the RESOLVED GraphBackend via its constructor
 * instead of hardcoding `new TokensaveBackend().cliMap()`. The backend's
 * `cliMap()` must be resolved LAZILY inside init()/sync()/status() — not in
 * the constructor — so constructing the CLI for a stub backend never throws
 * at construction time.
 *
 * As of Sprint 4, CodeReviewGraphBackend.cliMap() is REAL (init->build,
 * sync->update, status->status --json) — the init()/sync()/status() cases
 * below now assert the real argv/execa behavior instead of the Sprint-3
 * NOT_IMPL throw. As of Sprint 6, all 6 response *Plan adapters
 * (search/impact/reviewContext/overview/changes from Sprint 5, plus
 * queryPlan from Sprint 6) are real — asserted below.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execa before any import that would pull it in
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import type { CliMap, GraphBackend, PrereqSpec, ProcessSpec } from "../../src/graph/backends/types.js";
import { CodeReviewGraphBackend } from "../../src/graph/backends/code-review-graph-backend.js";
import { TokensaveBackend } from "../../src/graph/backends/tokensave-backend.js";

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

let tmp: string;

beforeEach(async () => {
  (execa as unknown as Mock).mockReset();
  tmp = await mkdtemp(join(tmpdir(), "bober-cli-backend-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ── Construction never throws, even for a stub backend ───────────────

describe("TokensaveCli — backend injection (sc-3-6)", () => {
  it("constructing the CLI with a CodeReviewGraphBackend does NOT throw", async () => {
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    expect(
      () => new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend()),
    ).not.toThrow();
  });

  // ── cr-graph cliMap is REAL as of Sprint 4 (sc-4-3) ──────────────────

  it("init() runs 'code-review-graph build' via the real cr-graph cliMap", async () => {
    mockExeca({ exitCode: 0, stdout: "Full build: 2 files, 8 nodes, 15 edges (postprocess=full)" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend());
    await cli.init({ languageTier: "core" });
    expect(execa).toHaveBeenCalledWith(
      "code-review-graph",
      ["build"],
      expect.objectContaining({ cwd: tmp, reject: false }),
    );
  });

  it("sync() runs 'code-review-graph update <paths>' via the real cr-graph cliMap", async () => {
    const syncOutput = "Incremental: 1 files updated, 4 nodes, 9 edges (postprocess=full)";
    // cli.sync() parses `result.all` (combined stdout+stderr) — set both so
    // the mock matches how execa's real `all: true` option behaves.
    mockExeca({ exitCode: 0, stdout: syncOutput, all: syncOutput });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend());
    const result = await cli.sync(["src/"], 2_000);
    expect(execa).toHaveBeenCalledWith(
      "code-review-graph",
      ["update", "src/"],
      expect.objectContaining({ cwd: tmp, reject: false }),
    );
    expect(result).toEqual({ indexed: 1 });
  });

  it("status() runs 'code-review-graph status --json' via the real cr-graph cliMap", async () => {
    mockExeca({
      exitCode: 0,
      stdout: JSON.stringify({ nodes: 8, edges: 15, files: 2, languages: ["python"] }),
    });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new CodeReviewGraphBackend());
    const result = await cli.status();
    expect(execa).toHaveBeenCalledWith(
      "code-review-graph",
      ["status", "--json"],
      expect.objectContaining({ cwd: tmp, reject: false }),
    );
    expect(result.ready).toBe(true);
    expect(result.indexedFileCount).toBe(2);
  });

  // ── All 6 response *Plan adapters are real as of Sprint 6 (queryPlan's
  //    4 sub-patterns; the other 5 — search/impact/reviewContext/overview/
  //    changes — landed in Sprint 5) — see
  //    tests/graph/backends/code-review-graph-backend.test.ts and
  //    tests/graph/client.test.ts for their fixture-driven coverage. ───

  it("queryPlan is implemented (Sprint 6); all 6 adapters route to real cr-graph tools", () => {
    const backend = new CodeReviewGraphBackend();
    const nodeRef = { id: "x", kind: "symbol" as const, file: "f.py", line: 1, symbol: "x" };
    expect(backend.queryPlan("callers_of", nodeRef).tool).toBe("query_graph_tool");
    expect(backend.queryPlan("callees_of", nodeRef).tool).toBe("query_graph_tool");
    expect(backend.queryPlan("imports_of", nodeRef).tool).toBe("query_graph_tool");
    expect(backend.queryPlan("tests_for", nodeRef).tool).toBe("query_graph_tool");
    expect(backend.searchPlan("x").tool).toBe("semantic_search_nodes_tool");
    expect(backend.impactPlan(nodeRef).tool).toBe("get_impact_radius_tool");
    expect(backend.reviewContextPlan([nodeRef]).tool).toBe("get_review_context_tool");
    expect(backend.overviewPlan().tool).toBe("get_architecture_overview_tool");
    expect(backend.changesPlan().tool).toBe("detect_changes_tool");
  });

  // ── Byte-identical for tokensave (default / unset backend) ──────────

  it("defaults to TokensaveBackend when no backend is injected (byte-identical argv)", async () => {
    mockExeca({ exitCode: 0 });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp);
    await cli.init({ languageTier: "core" });
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["init"],
      expect.objectContaining({ cwd: tmp, reject: false }),
    );
  });

  it("explicitly injecting a TokensaveBackend behaves identically to the default", async () => {
    mockExeca({ exitCode: 0, stdout: "", stderr: "", all: "" });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, new TokensaveBackend());
    await cli.status();
    expect(execa).toHaveBeenCalledWith(
      "tokensave",
      ["status", "--json"],
      expect.any(Object),
    );
  });

  // ── Binary resolution honors the injected backend ────────────────────

  it("uses the injected backend's own default binary when no binaryOverride is given", async () => {
    mockExeca({ exitCode: 0 });
    const fakeCliMap: CliMap = {
      initArgs: () => ["init"],
      syncArgs: (paths) => ["sync", ...paths],
      statusArgs: ["status", "--json"],
      parseSync: () => 0,
      parseStatus: () => ({ ready: false, indexedFileCount: 0, tokensaveVersion: "" }),
    };
    const fakeBackend: GraphBackend = {
      id: "fake-backend",
      searchPlan: () => {
        throw new Error("n/a");
      },
      queryPlan: () => {
        throw new Error("n/a");
      },
      impactPlan: () => {
        throw new Error("n/a");
      },
      reviewContextPlan: () => {
        throw new Error("n/a");
      },
      overviewPlan: () => {
        throw new Error("n/a");
      },
      changesPlan: () => {
        throw new Error("n/a");
      },
      processSpec: (): ProcessSpec => ({ binary: "fake-backend-binary", serveArgs: ["serve"] }),
      prereqSpec: (): PrereqSpec => ({
        versionArgs: ["--version"],
        isCompatible: () => true,
        installHint: () => "install fake-backend",
        incompatibleHint: () => "",
      }),
      cliMap: () => fakeCliMap,
    };
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, undefined, fakeBackend);
    await cli.init({ languageTier: "core" });
    expect(execa).toHaveBeenCalledWith("fake-backend-binary", ["init"], expect.any(Object));
  });

  it("an explicit binaryOverride still wins over the backend's default binary", async () => {
    mockExeca({ exitCode: 0 });
    const { TokensaveCli } = await import("../../src/graph/cli.js");
    const cli = new TokensaveCli(tmp, null, "/custom/tokensave", new TokensaveBackend());
    await cli.init({ languageTier: "core" });
    expect(execa).toHaveBeenCalledWith("/custom/tokensave", ["init"], expect.any(Object));
  });
});
