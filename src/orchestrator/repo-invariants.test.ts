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
import { execFileSync } from "node:child_process";
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
   *
   * Sprint 9 ships `writeFailureArtifact` (`.bober/failures`) and sprint 10 ships
   * `writeDigest` (`.bober/handoff`), so both make the same move. Note the SINGULAR
   * `.bober/handoff` — the plural `.bober/handoffs` is the skill-driven pipeline's
   * version-controlled `ContextHandoff` store and stays tracked.
   */
  const WRITTEN_RUNTIME_DIRS = [
    ".bober/scratch",
    ".bober/cache",
    ".bober/traces",
    ".bober/archive",
    ".bober/logs",
    ".bober/checkpoints",
    ".bober/failures",
    ".bober/handoff",
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


// ── The two persisted free-text artifacts ────────────────────────────

describe("the two persisted free-text artifacts: history.jsonl unpublished, progress.md scrubbed", () => {
  /**
   * WHY THIS IS AN INVARIANT AND NOT A ONE-OFF CLEANUP.
   *
   * `.bober/history.jsonl` is an append-only free-text log. Every writer puts
   * caller-supplied prose in it — feature requests, evaluator summaries, audit
   * notes — and there are ~40 `appendHistory`/`emitPhaseEvent` call sites across
   * BOTH engines, with more added every sprint. Nothing bounds what a future one
   * may write.
   *
   * It was tracked and committed until this change, and this repo's remote is
   * public, so the log was published on every push. Re-adding it is a single
   * `git add -f` away and would look like an innocuous "commit the run record"
   * diff, which is exactly why it needs a test rather than a comment.
   *
   * Nothing depends on the committed copy: every consumer (completion-tailer,
   * event-stream, the conformance harness) resolves the path under its own
   * `projectRoot`, and the whole test suite writes to temp roots.
   */
  const IGNORED_RUN_RECORDS = [".bober/history.jsonl", ".bober/history.archive.jsonl"];

  /** Exit status only — `git` writes the interesting part to its status code. */
  function gitSucceeds(args: readonly string[]): boolean {
    try {
      execFileSync("git", [...args], { cwd: REPO_ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  it("ignores the active log and its rotated sibling", () => {
    for (const path of IGNORED_RUN_RECORDS) {
      expect(gitSucceeds(["check-ignore", "-q", path]), `.gitignore must cover ${path}`).toBe(true);
    }
  });

  it("does not track the active log or its rotated sibling", () => {
    for (const path of IGNORED_RUN_RECORDS) {
      expect(
        gitSucceeds(["ls-files", "--error-unmatch", path]),
        `${path} must not be tracked — 'git rm --cached' it`,
      ).toBe(false);
    }
  });

  it("positive control: a genuinely tracked .bober artifact is tracked and not ignored", () => {
    // Proves the two assertions above read a real index and a real .gitignore,
    // rather than passing because every `git` invocation fails.
    const tracked = ".bober/topology/coding.json";
    expect(gitSucceeds(["ls-files", "--error-unmatch", tracked])).toBe(true);
    expect(gitSucceeds(["check-ignore", "-q", tracked])).toBe(false);
  });

  /**
   * The DELIBERATE asymmetry with the log, recorded so neither half drifts.
   *
   * `.bober/progress.md` stays TRACKED. Unlike the log it is a human-readable
   * document the skill-driven pipeline curates by documented contract (17 sites
   * across .claude/commands/*.md and .claude/agents/bober-planner.md, whose
   * header template lives at .claude/commands/bober-plan.md:52), and its
   * committed content carries no credentials, emails or home paths.
   *
   * What it DOES embed is `spec.description` — planner prose derived from the
   * operator's feature request, the same provenance as the log's `userPrompt`.
   * That is handled by scrubbing at the writer, not by unpublishing the file.
   */
  it("keeps progress.md tracked and unignored — the asymmetry is intentional", () => {
    expect(gitSucceeds(["ls-files", "--error-unmatch", ".bober/progress.md"])).toBe(true);
    expect(gitSucceeds(["check-ignore", "-q", ".bober/progress.md"])).toBe(false);
  });

  it("updateProgress scrubs every free-text string it embeds", async () => {
    // Source scan, because the failure mode is a NEW interpolation added later:
    // the behaviour tests only cover the three sites that exist today.
    //
    // Keyed on the property NAMES that carry prose (`.title` / `.description`)
    // rather than on the specific fields, so a future `feature.description`
    // pushed into the document is caught too. Numeric and id-shaped reads
    // (`spec.features.length`, `contract.contractId`, `contract.status`) do not
    // match and correctly need no scrubbing.
    const src = await readFile(join(SRC_ROOT, "state", "history.ts"), "utf-8");
    const body = src.slice(src.indexOf("export async function updateProgress"));
    const embedded = body
      .split("\n")
      .filter((l) => !isCommentLine(l))
      // Not keyed on `lines.push(` — the contract.title site wraps, leaving the
      // call and the interpolation on different lines.
      .filter((l) => /\.(title|description)\b/.test(l));

    expect(embedded.length, "the scan found the free-text sites").toBeGreaterThanOrEqual(3);
    const unscrubbed = embedded.filter((l) => !l.includes("scrubSensitive"));
    expect(unscrubbed, "every prose string in progress.md must be scrubbed").toEqual([]);
  });

  it("appendHistory routes every persisted line through the redactor", async () => {
    // The second layer: this repo untracks the log, but `appendHistory` ships in
    // the published CLI and runs in user projects that may commit theirs. If the
    // redaction call is dropped from the write path, that protection is gone with
    // no other test failing — the entry would still be valid JSONL.
    const src = await readFile(join(SRC_ROOT, "state", "history.ts"), "utf-8");
    const writeLine = src
      .split("\n")
      .filter((l) => !isCommentLine(l))
      .find((l) => l.includes("JSON.stringify") && l.includes("entry"));

    expect(writeLine, "history.ts must serialise the entry on one line").toBeDefined();
    expect(writeLine).toContain("redactHistoryEntry");
  });
});
