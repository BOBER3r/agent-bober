import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SecurityKnowledgeIndex } from "./index.js";
import type { SecurityStackId } from "./signature.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_SKILLS_ROOT = join(REPO_ROOT, "skills");

const ALL_STACK_IDS: SecurityStackId[] = [
  "solidity",
  "anchor",
  "react",
  "node",
  "payments",
  "igaming",
  "dex-backend",
  "generic",
];

// ── sc-5-2: real files, every stack indexes to >= 6 signatures ─────────

describe("SecurityKnowledgeIndex — real repository skills/", () => {
  it("loads and memoises all 8 stacks with >= 6 signatures each", async () => {
    const index = new SecurityKnowledgeIndex(REPO_SKILLS_ROOT);
    await index.load();

    for (const stackId of ALL_STACK_IDS) {
      const signatures = index.forStack(stackId);
      expect(signatures.length).toBeGreaterThanOrEqual(6);
      for (const signature of signatures) {
        expect(signature.stackId).toBe(stackId);
      }
    }
  });

  it("all() returns the union of every stack's signatures", async () => {
    const index = new SecurityKnowledgeIndex(REPO_SKILLS_ROOT);
    await index.load();

    const union = index.all();
    const perStackTotal = ALL_STACK_IDS.reduce((sum, id) => sum + index.forStack(id).length, 0);
    expect(union.length).toBe(perStackTotal);
  });

  it("load() is idempotent — a second call does not re-parse (memoised, ADR-7)", async () => {
    const index = new SecurityKnowledgeIndex(REPO_SKILLS_ROOT);
    await index.load();
    const before = index.forStack("solidity");
    await index.load();
    const after = index.forStack("solidity");
    // Same array instance -> proves the second load() was a no-op.
    expect(after).toBe(before);
  });

  it("resolves the default skillsRoot (three '..' from security-knowledge/) against the real repo skills dir", async () => {
    const index = new SecurityKnowledgeIndex();
    await index.load();
    expect(index.forStack("solidity").length).toBeGreaterThanOrEqual(6);
    expect(index.forStack("generic").length).toBeGreaterThanOrEqual(6);
  });
});

// ── never-throw fs discipline ────────────────────────────────────────

describe("SecurityKnowledgeIndex — missing/unreadable skill files", () => {
  let skillsRoot: string;

  beforeEach(async () => {
    skillsRoot = await mkdtemp(join(tmpdir(), "bober-security-knowledge-index-test-"));
  });

  afterEach(async () => {
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it("resolves forStack to [] for every stack when the skills directory is entirely empty, never throwing", async () => {
    const index = new SecurityKnowledgeIndex(skillsRoot);
    await expect(index.load()).resolves.toBeUndefined();

    for (const stackId of ALL_STACK_IDS) {
      expect(index.forStack(stackId)).toEqual([]);
    }
    expect(index.all()).toEqual([]);
  });

  it("never throws when skillsRoot itself does not exist", async () => {
    const index = new SecurityKnowledgeIndex(join(skillsRoot, "does-not-exist"));
    await expect(index.load()).resolves.toBeUndefined();
    expect(index.forStack("solidity")).toEqual([]);
  });

  it("indexes only the stacks with a real skill file, [] for the rest", async () => {
    const dir = join(skillsRoot, "bober.security-solidity");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "### solidity.example",
        "- **Title:** Example",
        "- **Severity:** high",
        "- **VulnClass:** injection",
        "- **Invariant:** Example invariant.",
        "",
        "**Unsafe:**",
        "```ts",
        "unsafe();",
        "```",
        "",
        "**Safe:**",
        "```ts",
        "safe();",
        "```",
      ].join("\n"),
      "utf-8",
    );

    const index = new SecurityKnowledgeIndex(skillsRoot);
    await index.load();

    expect(index.forStack("solidity").length).toBe(1);
    expect(index.forStack("anchor")).toEqual([]);
  });

  it("forStack returns [] before load() has been called", () => {
    const index = new SecurityKnowledgeIndex(skillsRoot);
    expect(index.forStack("solidity")).toEqual([]);
    expect(index.all()).toEqual([]);
  });
});
