/**
 * Colocated unit tests for the generator-diff artifact renderer.
 *
 * Placed at src/orchestrator/checkpoints/renderers/generator-diff.test.ts per the
 * COLOCATION HARD CONSTRAINT established in Sprints 8/9/10 — NOT in tests/orchestrator/.
 *
 * Sprint 11: s11-c6 (generator-diff renderer — stat, file list, binary skip, truncation).
 * Tests the sync `renderGeneratorDiff` and async `renderGeneratorDiffAsync`.
 */

import { describe, it, expect, vi } from "vitest";
import { renderGeneratorDiff, renderGeneratorDiffAsync } from "./generator-diff.js";
import type { GitClient } from "./generator-diff.js";

// ── Sync renderer (no git I/O) ─────────────────────────────────────────────────

describe("renderGeneratorDiff (sync — s11-c6)", () => {
  it("shows commit from artifact", () => {
    const out = renderGeneratorDiff({
      type: "generator-diff",
      commit: "abc1234",
      filesChanged: [],
    });
    expect(out).toContain("## Generator Diff");
    expect(out).toContain("abc1234");
  });

  it("lists filesChanged with action", () => {
    const out = renderGeneratorDiff({
      type: "generator-diff",
      commit: "def5678",
      filesChanged: [
        { path: "src/foo.ts", action: "created" },
        { path: "src/bar.ts", action: "modified" },
      ],
    });
    expect(out).toContain("### Files changed (2)");
    expect(out).toContain("`src/foo.ts` (created)");
    expect(out).toContain("`src/bar.ts` (modified)");
  });

  it("handles empty filesChanged gracefully", () => {
    const out = renderGeneratorDiff({ type: "generator-diff", commit: "abc" });
    expect(out).toContain("_No files listed in artifact._");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderGeneratorDiff({ type: "generator-diff", commit: "abc", filesChanged: [] });
    expect(out).toMatch(/^##\s/m);
    expect(out).not.toMatch(/^\s*\{/);
  });
});

// ── Async renderer (with git I/O) ──────────────────────────────────────────────

describe("renderGeneratorDiffAsync (s11-c6)", () => {
  function buildGitStub(overrides: Partial<GitClient> = {}): GitClient {
    return {
      diffStat: vi.fn(async () =>
        "src/foo.ts | 10 ++++++++++\n1 file changed, 10 insertions(+)",
      ),
      diffNumstat: vi.fn(async () => [
        { added: "10", deleted: "0", path: "src/foo.ts" },
        { added: "-", deleted: "-", path: "assets/logo.png" }, // binary
      ]),
      diffFile: vi.fn(async () => Array.from({ length: 80 }, (_, i) => `+line ${i}`).join("\n")),
      revListCount: vi.fn(async () => 3),
      ...overrides,
    };
  }

  it("shows commit count from git revListCount", async () => {
    const git = buildGitStub();
    const out = await renderGeneratorDiffAsync(
      { type: "generator-diff", baseRef: "HEAD~3", headRef: "HEAD" },
      git,
    );
    expect(out).toContain("**Commits:** 3");
  });

  it("shows diff stat block", async () => {
    const git = buildGitStub();
    const out = await renderGeneratorDiffAsync(
      { type: "generator-diff", baseRef: "HEAD~3", headRef: "HEAD" },
      git,
    );
    expect(out).toContain("### Diff stat");
    expect(out).toContain("1 file changed");
  });

  it("skips binary files (lists name but no inline content)", async () => {
    const git = buildGitStub();
    const out = await renderGeneratorDiffAsync(
      { type: "generator-diff", baseRef: "HEAD~3", headRef: "HEAD" },
      git,
    );
    expect(out).toContain("### Binary files (not rendered inline)");
    expect(out).toContain("assets/logo.png");
    // Binary file content should NOT be rendered
    expect(out).not.toMatch(/\+\+\+ b\/assets\/logo\.png/);
  });

  it("truncates per-file diff at 50 lines with truncation marker", async () => {
    const git = buildGitStub();
    const out = await renderGeneratorDiffAsync(
      { type: "generator-diff", baseRef: "HEAD~3", headRef: "HEAD" },
      git,
    );
    // The 80-line diff should be truncated
    expect(out).toMatch(/<\d+ more lines truncated, see src\/foo\.ts:/);
  });

  it("falls back to file list when no baseRef provided", async () => {
    const git = buildGitStub();
    const out = await renderGeneratorDiffAsync(
      {
        type: "generator-diff",
        filesChanged: [{ path: "src/x.ts", action: "created" }],
      },
      git,
    );
    expect(out).toContain("### Files changed (1)");
    // No git calls should be made without baseRef
    expect(git.diffStat).not.toHaveBeenCalled();
  });
});
