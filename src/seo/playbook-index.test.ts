import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { SeoPlaybookIndex } from "./playbook-index.js";

// src/seo/playbook-index.test.ts -> repo root is TWO ".." up (src/seo -> src -> root).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_SKILLS_ROOT = join(REPO_ROOT, "skills");

// ── sc-2-3 / sc-2-2: real repo skills — index loads the generic floor ──

describe("SeoPlaybookIndex — real repository skills/", () => {
  it("loads and memoises >=10 signatures from skills/bober.seo-generic/SKILL.md", async () => {
    const index = new SeoPlaybookIndex(REPO_SKILLS_ROOT);
    const signatures = await index.load();

    expect(signatures.length).toBeGreaterThanOrEqual(10);
    for (const s of signatures) {
      expect(s.skillRef).toContain("bober.seo-generic");
    }
  });

  it("generic() returns every signature authored in the generic skill", async () => {
    const index = new SeoPlaybookIndex(REPO_SKILLS_ROOT);
    await index.load();
    expect(index.generic().length).toBeGreaterThanOrEqual(10);
  });

  it("all() returns the same signatures as load()'s resolved value", async () => {
    const index = new SeoPlaybookIndex(REPO_SKILLS_ROOT);
    const loaded = await index.load();
    expect(index.all()).toEqual(loaded);
  });

  it("load() is idempotent — a second call returns the SAME array instance", async () => {
    const index = new SeoPlaybookIndex(REPO_SKILLS_ROOT);
    const first = await index.load();
    const second = await index.load();
    expect(second).toBe(first);
  });

  it("resolves the default skillsRoot (two '..' from src/seo/) against the real repo skills dir", async () => {
    const index = new SeoPlaybookIndex();
    const signatures = await index.load();
    expect(signatures.length).toBeGreaterThanOrEqual(10);
  });
});

// ── never-throw fs discipline (sc-2-3) ─────────────────────────────────

describe("SeoPlaybookIndex — missing/unreadable skill files", () => {
  let skillsRoot: string;

  beforeEach(async () => {
    skillsRoot = await mkdtemp(join(tmpdir(), "bober-seo-playbook-index-test-"));
  });

  afterEach(async () => {
    await rm(skillsRoot, { recursive: true, force: true });
  });

  it("returns [] without throwing when the skills directory is entirely empty", async () => {
    const index = new SeoPlaybookIndex(skillsRoot);
    await expect(index.load()).resolves.toEqual([]);
    expect(index.all()).toEqual([]);
    expect(index.generic()).toEqual([]);
  });

  it("never throws when skillsRoot itself does not exist", async () => {
    const index = new SeoPlaybookIndex(join(skillsRoot, "does-not-exist"));
    await expect(index.load()).resolves.toEqual([]);
    expect(index.all()).toEqual([]);
  });

  it("skips a non-seo skill dir and a bober.seo-* dir with no valid blocks, harmlessly", async () => {
    await mkdir(join(skillsRoot, "bober.security-generic"), { recursive: true });
    await writeFile(join(skillsRoot, "bober.security-generic", "SKILL.md"), "not seo content", "utf-8");

    const emptyPlaybookDir = join(skillsRoot, "bober.seo-empty");
    await mkdir(emptyPlaybookDir, { recursive: true });
    await writeFile(join(emptyPlaybookDir, "SKILL.md"), "### no-fields\nnothing here", "utf-8");

    const index = new SeoPlaybookIndex(skillsRoot);
    const signatures = await index.load();
    expect(signatures).toEqual([]);
  });

  it("indexes a real bober.seo-* dir with one valid signature", async () => {
    const dir = join(skillsRoot, "bober.seo-generic");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      [
        "### example-signal",
        "- **Title:** Example",
        "- **Workflows:** ai-visibility",
        "- **Tactic:** Do the thing.",
        "- **Invariant:** Because evidence.",
        "- **PrimarySourceUrl:** https://example.com/study",
        "- **PolicyClass:** auto-safe",
        "- **EvidenceGrade:** verified",
        "- **Keywords:** example",
      ].join("\n"),
      "utf-8",
    );

    const index = new SeoPlaybookIndex(skillsRoot);
    const signatures = await index.load();
    expect(signatures).toHaveLength(1);
    expect(signatures[0].playbookId).toBe("example-signal");
    expect(index.generic()).toHaveLength(1);
  });

  it("a directory that is not a bober.seo-* prefix is never read, even if it contains a SKILL.md", async () => {
    await mkdir(join(skillsRoot, "not-a-seo-skill"), { recursive: true });
    await writeFile(
      join(skillsRoot, "not-a-seo-skill", "SKILL.md"),
      "### x\n- **Title:** t\n- **PrimarySourceUrl:** https://x\n- **PolicyClass:** auto-safe",
      "utf-8",
    );

    const index = new SeoPlaybookIndex(skillsRoot);
    expect(await index.load()).toEqual([]);
  });

  it("all() and generic() return [] before load() has been called", () => {
    const index = new SeoPlaybookIndex(skillsRoot);
    expect(index.all()).toEqual([]);
    expect(index.generic()).toEqual([]);
  });
});
