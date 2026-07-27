/**
 * Unit tests for CodeReviewGraphBackend's non-adapter surface (sc-4-2/4-3).
 *
 * The 6 response *Plan adapters stay untested here — they still throw
 * NOT_IMPL until Sprints 5-6 (covered by cli-backend-injection.test.ts,
 * which asserts the throw behaviour end-to-end via TokensaveCli).
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";
import { CodeReviewGraphBackend } from "../../../src/graph/backends/code-review-graph-backend.js";
import { GenericPrereqCheck } from "../../../src/graph/prereq.js";

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
});
