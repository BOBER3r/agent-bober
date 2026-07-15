/**
 * SeoPlaybookIndex — per-process memoised catalog of every bober.seo-*
 * skill's parsed SeoSignature[] (spec-20260715-ultimate-seo-suite, Sprint 2;
 * mirrors `SecurityKnowledgeIndex`, src/orchestrator/security-knowledge/index.ts:35-70).
 *
 * Unlike the security index (fixed per-stack registry, `forStack` map), this
 * index is a FLAT list: it `readdir`s the skills directory for every
 * `bober.seo-*` entry (auto-discovering the per-workflow skills sprints 3-5
 * add later — a non-playbook or empty skill parses to `[]`, harmlessly) and
 * concatenates their parsed signatures. `load()` RETURNS the memoised list
 * (the security template's `load()` returns void).
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SeoPlaybookParser } from "./parser.js";
import type { SeoSignature } from "./types.js";

/**
 * `src/seo/` sits ONE level below `src/` (unlike
 * `src/orchestrator/security-knowledge/`, which sits two levels below
 * `src/`), so the default skills root needs TWO `..`, not three:
 * src/seo/ -> package root is ../.. ; skills live at <packageRoot>/skills.
 */
function defaultSkillsRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "skills");
}

export class SeoPlaybookIndex {
  private cache: SeoSignature[] | null = null;

  constructor(private readonly skillsRoot: string = defaultSkillsRoot()) {}

  /**
   * Parses every `skills/bober.seo-*` skill's `SKILL.md` file once and
   * memoises the flat signature list. Idempotent — a second call returns the SAME array
   * instance without re-reading the filesystem. Never throws: a missing
   * skills directory, or any individual unreadable/unparseable SKILL.md,
   * degrades to [] for that source rather than rejecting.
   */
  async load(): Promise<SeoSignature[]> {
    if (this.cache) return this.cache;

    const out: SeoSignature[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.skillsRoot);
    } catch {
      this.cache = [];
      return this.cache;
    }

    for (const name of entries.filter((n) => n.startsWith("bober.seo-"))) {
      const rel = join(name, "SKILL.md");
      try {
        const markdown = await readFile(join(this.skillsRoot, rel), "utf-8");
        out.push(...SeoPlaybookParser.parse(markdown, rel));
      } catch {
        // Missing/unreadable SKILL.md -> skip, never throw.
      }
    }

    this.cache = out;
    return this.cache;
  }

  /** The full memoised list, or [] before load() has been called. Never throws. */
  all(): SeoSignature[] {
    return this.cache ?? [];
  }

  /** Every signature authored in the generic skill — the retriever's always-included floor. */
  generic(): SeoSignature[] {
    return this.all().filter((s) => s.skillRef.includes("bober.seo-generic"));
  }
}
