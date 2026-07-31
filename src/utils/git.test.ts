/**
 * Unit tests for the deterministic `.gitignore` helper (sc-1-3).
 *
 * Tests:
 * - creates .gitignore + entry when the file is missing
 * - appends the entry when the file exists but lacks it
 * - is idempotent on a second call (no duplicate line)
 * - preserves unrelated existing lines byte-for-byte
 * - is a no-op when an existing pattern already covers the directory
 *   (any of `dir`, `dir/`, `/dir`, `/dir/` trimmed-line forms)
 *
 * Uses a real `mkdtemp` fixture — no fs mocks (principles.md line 44).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { ensureGitignoreEntry } from "./git.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-gitignore-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("ensureGitignoreEntry (sc-1-3)", () => {
  it("creates .gitignore with the entry when the file is missing", async () => {
    const appended = await ensureGitignoreEntry(tmpRoot, "docs/local");
    expect(appended).toBe(true);

    const content = await readFile(join(tmpRoot, ".gitignore"), "utf-8");
    expect(content).toBe("docs/local/\n");
  });

  it("appends the entry when .gitignore exists but does not cover it", async () => {
    await writeFile(join(tmpRoot, ".gitignore"), "node_modules/\ndist/\n", "utf-8");

    const appended = await ensureGitignoreEntry(tmpRoot, "docs/local");
    expect(appended).toBe(true);

    const content = await readFile(join(tmpRoot, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\ndist/\ndocs/local/\n");
  });

  it("is idempotent — a second call appends nothing", async () => {
    await ensureGitignoreEntry(tmpRoot, "docs/local");
    const secondAppended = await ensureGitignoreEntry(tmpRoot, "docs/local");
    expect(secondAppended).toBe(false);

    const content = await readFile(join(tmpRoot, ".gitignore"), "utf-8");
    expect(content).toBe("docs/local/\n");
  });

  it("preserves unrelated lines byte-for-byte", async () => {
    const original = "# comment\nnode_modules/\n*.log\n";
    await writeFile(join(tmpRoot, ".gitignore"), original, "utf-8");

    await ensureGitignoreEntry(tmpRoot, "docs/local");

    const content = await readFile(join(tmpRoot, ".gitignore"), "utf-8");
    expect(content).toBe("# comment\nnode_modules/\n*.log\ndocs/local/\n");
  });

  it("is a no-op when an existing pattern already covers the dir (trailing slash form)", async () => {
    await writeFile(join(tmpRoot, ".gitignore"), "docs/sprints/\n", "utf-8");

    const appended = await ensureGitignoreEntry(tmpRoot, "docs/sprints");
    expect(appended).toBe(false);

    const content = await readFile(join(tmpRoot, ".gitignore"), "utf-8");
    expect(content).toBe("docs/sprints/\n");
  });

  it("is a no-op when an existing pattern already covers the dir (no-trailing-slash form)", async () => {
    await writeFile(join(tmpRoot, ".gitignore"), "docs/sprints\n", "utf-8");

    const appended = await ensureGitignoreEntry(tmpRoot, "docs/sprints");
    expect(appended).toBe(false);
  });

  it("is a no-op when an existing pattern already covers the dir (leading-slash form)", async () => {
    await writeFile(join(tmpRoot, ".gitignore"), "/docs/sprints/\n", "utf-8");

    const appended = await ensureGitignoreEntry(tmpRoot, "docs/sprints");
    expect(appended).toBe(false);
  });

  it("handles a .gitignore that does not end with a trailing newline", async () => {
    await writeFile(join(tmpRoot, ".gitignore"), "node_modules/", "utf-8");

    await ensureGitignoreEntry(tmpRoot, "docs/local");

    const content = await readFile(join(tmpRoot, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules/\ndocs/local/\n");
  });
});
