// ── repo-invariants.test.ts ──────────────────────────────────────────
//
// Two repository-level structural invariants this sprint pins. Neither can be
// expressed as a type and neither would be caught by any behavioural test:
//
//  1. SINGLE OWNER. The wire literals `"pipeline-complete"` and
//     `".completed.json"` may appear in exactly one production module,
//     src/orchestrator/finalize.ts, as exported constants. A second literal
//     anywhere else is a divergence waiting to strand a run — the producer and
//     the consumer would compile, pass their own tests, and silently disagree.
//
//  2. NO PREMATURE .gitignore ENTRIES (sc-4-8). The runtime directories the
//     later PGE sprints introduce must be ignored by the sprint that creates
//     them, not by this one — an ignore rule landing early hides a directory
//     nobody is writing yet and quietly stops being reviewed.

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");

// ── Source scan ──────────────────────────────────────────────────────

/**
 * The ONLY production module permitted to spell either wire literal.
 * Paths are repo-relative with forward slashes.
 */
const OWNER = "src/orchestrator/finalize.ts";

/** Exact quoted forms of the event name — prose mentions do not match. */
const EVENT_LITERAL = /["'`]pipeline-complete["'`]/;
/** The marker suffix in any position; no production code outside the owner needs it. */
const MARKER_LITERAL = /\.completed\.json/;

/**
 * Comment heuristic: a line whose first non-space characters open or continue a
 * comment. Deliberately conservative — it only ever EXCLUDES lines, so a line
 * it fails to recognise as a comment is reported rather than hidden.
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

async function collectTsFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      await collectTsFiles(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function relative(path: string): string {
  return path.slice(REPO_ROOT.length).split("\\").join("/");
}

describe("terminal side-effect set has exactly one owner", () => {
  it('only finalize.ts spells the "pipeline-complete" literal in production code', async () => {
    const files = await collectTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(200); // the scan actually walked the tree

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(file);
      if (rel === OWNER) continue;
      const lines = (await readFile(file, "utf-8")).split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (EVENT_LITERAL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("only finalize.ts spells the .completed.json suffix in production code", async () => {
    const files = await collectTsFiles(SRC_ROOT);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(file);
      if (rel === OWNER) continue;
      const lines = (await readFile(file, "utf-8")).split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (MARKER_LITERAL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the scan is live: finalize.ts itself matches both patterns", async () => {
    const owner = await readFile(join(REPO_ROOT, OWNER), "utf-8");
    const codeLines = owner.split("\n").filter((l) => !isCommentLine(l));
    expect(codeLines.some((l) => EVENT_LITERAL.test(l))).toBe(true);
    expect(codeLines.some((l) => MARKER_LITERAL.test(l))).toBe(true);
  });

  it("the consumer imports the constants rather than re-declaring them", async () => {
    const tailer = await readFile(join(SRC_ROOT, "chat", "completion-tailer.ts"), "utf-8");
    expect(tailer).toContain("COMPLETION_MARKER_SUFFIX");
    expect(tailer).toContain("PIPELINE_COMPLETE_EVENT");
    expect(tailer).toMatch(/from "\.\.\/orchestrator\/finalize\.js"/);
  });
});

// ── sc-4-8: .gitignore gains no runtime directories in this sprint ────

describe(".gitignore / .bober runtime paths (sc-4-8)", () => {
  /**
   * Directories no sprint writes YET.
   *
   * Sprint 6 (sc-6-10) shipped `ScratchStore`, `ArchiveWriter`, `SemanticCache` and
   * `TraceWriter`, so `.bober/{scratch,cache,traces,archive}` left this list and moved
   * into {@link SPRINT_6_DIRS} below — the rule this describe block encodes is "ignored
   * in the same change that creates it", in BOTH directions, not "never ignored".
   * `.bober/checkpoints` belongs to the FsCheckpointer in sprint 7 and stays here.
   */
  const FUTURE_DIRS = [".bober/checkpoints"];

  /** Created by sprint 6 and therefore required to be ignored as of that change. */
  const SPRINT_6_DIRS = [
    ".bober/scratch",
    ".bober/cache",
    ".bober/traces",
    ".bober/archive",
    ".bober/logs",
  ];

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async function ignoreRules(): Promise<string[]> {
    const gitignore = await readFile(join(REPO_ROOT, ".gitignore"), "utf-8");
    return gitignore
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  }

  it("adds no ignore rule for a directory nothing writes yet", async () => {
    const rules = await ignoreRules();
    for (const dir of FUTURE_DIRS) {
      const matching = rules.filter((r) => r.replace(/\/$/, "") === dir);
      expect(matching, `.gitignore must not list ${dir} until the sprint that creates it`).toEqual([]);
    }
  });

  it("carries an ignore rule for every directory sprint 6 does write", async () => {
    const rules = await ignoreRules();
    for (const dir of SPRINT_6_DIRS) {
      const matching = rules.filter((r) => r.replace(/\/$/, "") === dir);
      expect(matching, `.gitignore must list ${dir}`).toEqual([`${dir}/`]);
    }
  });

  it("those .bober/ directories are still absent from the working tree", async () => {
    for (const dir of FUTURE_DIRS) {
      expect(await exists(join(REPO_ROOT, dir)), `${dir} must not exist yet`).toBe(false);
    }
  });

  it("positive control: the sprint-1 topology artifact IS present and NOT ignored", async () => {
    // Proves the two assertions above are reading a real .gitignore and a real
    // tree rather than passing because every lookup fails.
    expect(await exists(join(REPO_ROOT, ".bober", "topology", "coding.json"))).toBe(true);
    const gitignore = await readFile(join(REPO_ROOT, ".gitignore"), "utf-8");
    expect(gitignore).not.toContain(".bober/topology");
  });
});
