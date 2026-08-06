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
   * The rule this describe block encodes: a `.bober/` runtime directory is ignored in the
   * SAME change that creates a writer for it — in both directions, not "never ignored".
   *
   * Sprint 6 (sc-6-10) shipped `ScratchStore`, `ArchiveWriter`, `SemanticCache` and
   * `TraceWriter`, so `.bober/{scratch,cache,traces,archive,logs}` became required.
   * Sprint 8 (sc-8-11) ships `FsCheckpointer`, so `.bober/checkpoints` joins them — the
   * FUTURE list that held it is now empty and the entry moved down, which is exactly the
   * transition the rule describes.
   */
  const WRITTEN_RUNTIME_DIRS = [
    ".bober/scratch",
    ".bober/cache",
    ".bober/traces",
    ".bober/archive",
    ".bober/logs",
    ".bober/checkpoints",
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

  it("carries an ignore rule for every .bober/ runtime directory a shipped component writes", async () => {
    const rules = await ignoreRules();
    for (const dir of WRITTEN_RUNTIME_DIRS) {
      const matching = rules.filter((r) => r.replace(/\/$/, "") === dir);
      expect(matching, `.gitignore must list ${dir}`).toEqual([`${dir}/`]);
    }
  });

  it("ignores no .bober/ directory beyond the ones a shipped component writes", async () => {
    // The other direction of the same rule: a speculative ignore rule for a directory
    // nothing writes hides a future artifact from review the moment it appears.
    const allowed = new Set([
      ...WRITTEN_RUNTIME_DIRS,
      // Pre-PGE runtime state, each with a shipped writer of its own.
      ".bober/snapshots",
      ".bober/medical",
      ".bober/chat",
    ]);
    const boberRules = (await ignoreRules())
      .filter((rule) => rule.startsWith(".bober/"))
      // File-level rules (`.bober/memory/*.db`, `.bober/graph/.hook-queue.jsonl`) are not
      // directory ignores and are out of this rule's scope.
      .filter((rule) => rule.endsWith("/"))
      .map((rule) => rule.replace(/\/$/, ""));

    expect(boberRules.filter((rule) => !allowed.has(rule))).toEqual([]);
  });

  it("keeps the checkpoint tree out of the developer's own repository", async () => {
    // Every checkpoint in the suite goes to a temp root, because `createFsCheckpointer`
    // takes `projectRoot` as a required argument and there is no module-level instance.
    expect(
      await exists(join(REPO_ROOT, ".bober", "checkpoints")),
      ".bober/checkpoints must never be written into the repo root",
    ).toBe(false);
  });

  it("positive control: the sprint-1 topology artifact IS present and NOT ignored", async () => {
    // Proves the two assertions above are reading a real .gitignore and a real
    // tree rather than passing because every lookup fails.
    expect(await exists(join(REPO_ROOT, ".bober", "topology", "coding.json"))).toBe(true);
    const gitignore = await readFile(join(REPO_ROOT, ".gitignore"), "utf-8");
    expect(gitignore).not.toContain(".bober/topology");
  });
});
