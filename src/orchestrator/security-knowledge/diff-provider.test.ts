/**
 * Unit tests for the sprint-6 orchestrator-owned real-diff provider
 * (src/orchestrator/security-knowledge/diff-provider.ts).
 *
 * sc-6-1: injected GitRunner -> parsed AuditDiff; throwing/failed runner ->
 * EMPTY_DIFF (never throws); changedFiles-count and hunk-byte caps -> truncated:true.
 * sc-6-2: graph neighborhood expansion, gated on engineHealth === 'ready'.
 *
 * Never shells real git — every test injects a fake GitRunner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitRunner, ChangedFile } from "./diff-provider.js";

const getGraphStateSpy = vi.fn();
const getGraphDepsSpy = vi.fn();

vi.mock("../tools/index.js", () => ({
  getGraphState: (...args: unknown[]) => getGraphStateSpy(...args),
  getGraphDeps: (...args: unknown[]) => getGraphDepsSpy(...args),
}));

const { securityDiffProvider, parseUnifiedDiff, extractDiffKeywords, EMPTY_DIFF } =
  await import("./diff-provider.js");

beforeEach(() => {
  getGraphStateSpy.mockReset();
  getGraphStateSpy.mockReturnValue({ graphEnabled: false, engineHealth: "disabled" });
  getGraphDepsSpy.mockReset();
  getGraphDepsSpy.mockReturnValue(null);
});

// ── Fixtures ────────────────────────────────────────────────────────

const nameStatusFixture = "M\tsrc/foo.ts\nA\tsrc/bar.ts\nD\tsrc/baz.ts\n";

const unifiedFixture = `diff --git a/src/foo.ts b/src/foo.ts
index e69de29..4b825dc 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 line1
+const rows = db.raw('SELECT * FROM users');
 line2
 line3
diff --git a/src/bar.ts b/src/bar.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/bar.ts
@@ -0,0 +1,2 @@
+export const bar = 1;
+export const barTwo = 2;
diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
index e69de29..0000000
--- a/src/baz.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const baz = 1;
-export const qux = 2;
`;

function makeRunner(byPrefix: Record<string, { stdout: string; failed?: boolean; exitCode?: number }>): GitRunner {
  return vi.fn(async (args) => {
    const key = args.slice(0, 2).join(" ");
    const match = byPrefix[key];
    if (!match) return { exitCode: 1, stdout: "", failed: true };
    return { exitCode: match.exitCode ?? 0, stdout: match.stdout, failed: match.failed ?? false };
  });
}

// ── parseUnifiedDiff (pure) — sc-6-1 ─────────────────────────────────

describe("parseUnifiedDiff — sc-6-1", () => {
  it("parses name-status + unified diff into ChangedFile[] with hunks, statuses and content", () => {
    const { files, truncated } = parseUnifiedDiff(nameStatusFixture, unifiedFixture);

    expect(truncated).toBe(false);
    expect(files).toHaveLength(3);

    const foo = files.find((f) => f.path === "src/foo.ts");
    expect(foo?.status).toBe("modified");
    expect(foo?.hunks).toHaveLength(1);
    expect(foo?.hunks[0].content).toContain(".raw(");
    expect(foo?.hunks[0].startLine).toBe(1);
    expect(foo?.hunks[0].lineCount).toBe(4);

    const bar = files.find((f) => f.path === "src/bar.ts");
    expect(bar?.status).toBe("added");
    expect(bar?.hunks).toHaveLength(1);

    const baz = files.find((f) => f.path === "src/baz.ts");
    expect(baz?.status).toBe("deleted");
    expect(baz?.hunks).toHaveLength(1);
    expect(baz?.hunks[0].content).toContain("export const baz = 1;");
  });

  it("maps a rename name-status line ('Rnnn\\told\\tnew') to status 'renamed' keyed by the new path", () => {
    const { files } = parseUnifiedDiff("R100\tsrc/old.ts\tsrc/new.ts\n", "");
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({ path: "src/new.ts", status: "renamed", hunks: [] });
  });

  it("returns [] files and truncated:false for empty input — never throws", () => {
    expect(parseUnifiedDiff("", "")).toEqual({ files: [], truncated: false });
  });

  it("is defensive against non-string input — never throws", () => {
    expect(parseUnifiedDiff(undefined as unknown as string, undefined as unknown as string)).toEqual({
      files: [],
      truncated: false,
    });
  });

  it("caps changedFiles at 60 and sets truncated:true when exceeded", () => {
    const many = Array.from({ length: 70 }, (_, i) => `M\tsrc/file${i}.ts`).join("\n");
    const { files, truncated } = parseUnifiedDiff(many, "");
    expect(files).toHaveLength(60);
    expect(truncated).toBe(true);
  });

  it("caps total hunk bytes and sets truncated:true when exceeded, dropping the overflowing hunk", () => {
    const bigLine = `+${"x".repeat(2000)}`;
    const manyLines = Array.from({ length: 200 }, () => bigLine).join("\n"); // ~400KB, over the 256KB cap
    const bigUnified = [
      "diff --git a/src/big.ts b/src/big.ts",
      "--- a/src/big.ts",
      "+++ b/src/big.ts",
      "@@ -1,1 +1,200 @@",
      manyLines,
      "",
    ].join("\n");

    const { files, truncated } = parseUnifiedDiff("M\tsrc/big.ts", bigUnified);
    expect(truncated).toBe(true);
    expect(files).toHaveLength(1);
    // the single oversized hunk cannot fit at all -> dropped entirely
    expect(files[0].hunks).toHaveLength(0);
  });
});

// ── extractDiffKeywords (pure) ────────────────────────────────────────

describe("extractDiffKeywords", () => {
  it("extracts notable substrings and identifiers from added/removed lines only, skipping context lines", () => {
    const files: ChangedFile[] = [
      {
        path: "src/foo.ts",
        status: "modified",
        hunks: [
          {
            startLine: 1,
            lineCount: 2,
            content: [
              "@@ -1,1 +1,2 @@",
              " unchangedContextToken line",
              "+const rows = db.raw('SELECT * FROM users');",
              "-const oldVar = 1;",
            ].join("\n"),
          },
        ],
      },
    ];

    const keywords = extractDiffKeywords(files);
    expect(keywords).toContain(".raw(");
    expect(keywords).toContain("rows");
    expect(keywords).toContain("oldVar");
    expect(keywords).not.toContain("unchangedContextToken");
  });

  it("never throws on malformed input", () => {
    expect(extractDiffKeywords(null as unknown as ChangedFile[])).toEqual([]);
    expect(extractDiffKeywords([{ path: "x" } as unknown as ChangedFile])).toEqual([]);
    expect(extractDiffKeywords([{ path: "x", status: "modified", hunks: [{}] } as unknown as ChangedFile[]])).toEqual(
      [],
    );
  });
});

// ── securityDiffProvider.compute — sc-6-1 (injected GitRunner) ───────

describe("securityDiffProvider.compute — sc-6-1", () => {
  it("returns a parsed AuditDiff when the injected runner resolves name-status + unified diff", async () => {
    const runner = makeRunner({
      "diff --name-status": { stdout: nameStatusFixture },
      "diff -U3": { stdout: unifiedFixture },
    });

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: false,
      signal: new AbortController().signal,
      runner,
    });

    expect(result.changedFiles).toHaveLength(3);
    expect(result.neighborhoodFiles).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(runner).toHaveBeenCalledWith(["diff", "--name-status", "main"], expect.any(Object));
    expect(runner).toHaveBeenCalledWith(["diff", "-U3", "main"], expect.any(Object));
  });

  it("degrades to EMPTY_DIFF when the runner throws — never throws itself", async () => {
    const runner: GitRunner = vi.fn(async () => {
      throw new Error("ENOENT: git not found");
    });

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: false,
      signal: new AbortController().signal,
      runner,
    });

    expect(result).toEqual(EMPTY_DIFF);
  });

  it("degrades to EMPTY_DIFF when the runner resolves failed:true (not-a-repo / nonzero exit)", async () => {
    const runner: GitRunner = vi.fn(async () => ({ exitCode: 128, stdout: "", failed: true }));

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: false,
      signal: new AbortController().signal,
      runner,
    });

    expect(result).toEqual(EMPTY_DIFF);
  });

  it("degrades to EMPTY_DIFF and never calls the runner when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner: GitRunner = vi.fn();

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: false,
      signal: controller.signal,
      runner,
    });

    expect(result).toEqual(EMPTY_DIFF);
    expect(runner).not.toHaveBeenCalled();
  });
});

// ── securityDiffProvider.compute — sc-6-2 (graph neighborhood) ───────

describe("securityDiffProvider.compute — sc-6-2 graph neighborhood expansion", () => {
  it("adds neighborhoodFiles via GraphClient.impact when expandWithGraph and engineHealth==='ready'", async () => {
    getGraphStateSpy.mockReturnValue({ graphEnabled: true, engineHealth: "ready" });
    const impactMock = vi.fn(async (target: string) => ({
      ok: true,
      data: {
        root: { id: target, kind: "module", file: target, line: 0, symbol: target },
        affected: [{ id: "n1", kind: "module", file: "src/neighbor.ts", line: 0, symbol: "neighbor" }],
        testsAffected: [],
      },
      backend: "mcp",
      durationMs: 1,
    }));
    getGraphDepsSpy.mockReturnValue({ client: { impact: impactMock }, fallback: {} });

    const runner = makeRunner({
      "diff --name-status": { stdout: "M\tsrc/foo.ts" },
      "diff -U3": { stdout: "" },
    });

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: true,
      signal: new AbortController().signal,
      runner,
    });

    expect(result.changedFiles).toHaveLength(1);
    expect(result.neighborhoodFiles).toEqual(["src/neighbor.ts"]);
    expect(impactMock).toHaveBeenCalledWith("src/foo.ts");
  });

  it("skips graph expansion (neighborhoodFiles:[]) when engineHealth is not 'ready' — changedFiles still returned", async () => {
    getGraphStateSpy.mockReturnValue({ graphEnabled: true, engineHealth: "starting" });

    const runner = makeRunner({
      "diff --name-status": { stdout: "M\tsrc/foo.ts" },
      "diff -U3": { stdout: "" },
    });

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: true,
      signal: new AbortController().signal,
      runner,
    });

    expect(result.changedFiles).toHaveLength(1);
    expect(result.neighborhoodFiles).toEqual([]);
    expect(getGraphDepsSpy).not.toHaveBeenCalled();
  });

  it("treats a GraphResult ok:false as neighborhoodFiles:[] without dropping the git-derived changedFiles", async () => {
    getGraphStateSpy.mockReturnValue({ graphEnabled: true, engineHealth: "ready" });
    const impactMock = vi.fn(async () => ({ ok: false, reason: "GRAPH_ERROR", detail: "boom" }));
    getGraphDepsSpy.mockReturnValue({ client: { impact: impactMock }, fallback: {} });

    const runner = makeRunner({
      "diff --name-status": { stdout: "M\tsrc/foo.ts" },
      "diff -U3": { stdout: "" },
    });

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: true,
      signal: new AbortController().signal,
      runner,
    });

    expect(result.changedFiles).toHaveLength(1);
    expect(result.neighborhoodFiles).toEqual([]);
  });

  it("does not expand the graph at all when expandWithGraph is false, even if the graph is ready", async () => {
    getGraphStateSpy.mockReturnValue({ graphEnabled: true, engineHealth: "ready" });
    const impactMock = vi.fn();
    getGraphDepsSpy.mockReturnValue({ client: { impact: impactMock }, fallback: {} });

    const runner = makeRunner({
      "diff --name-status": { stdout: "M\tsrc/foo.ts" },
      "diff -U3": { stdout: "" },
    });

    const result = await securityDiffProvider.compute({
      projectRoot: "/tmp/project",
      baseRef: "main",
      expandWithGraph: false,
      signal: new AbortController().signal,
      runner,
    });

    expect(result.neighborhoodFiles).toEqual([]);
    expect(impactMock).not.toHaveBeenCalled();
  });
});
