/**
 * SecurityKnowledgeIndex — NOT a barrel. This module is the knowledge-index
 * class (a per-process memoised catalog of every stack's parsed
 * SecuritySignature[], ADR-7); it does not re-export sibling modules. Import
 * it explicitly as `./security-knowledge/index.js`.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SecuritySignatureParser } from "./parser.js";
import type { SecuritySignature, SecurityStackId } from "./signature.js";
import { STACK_SKILL_MAP_ENTRIES } from "./registry.js";

/**
 * `security-knowledge/` is one directory deeper than `stack-knowledge.ts`
 * (`src/orchestrator/`), so the default skills root needs three `..`, not
 * two: src/orchestrator/security-knowledge/ -> package root is ../../.. ;
 * skills live at <packageRoot>/skills.
 */
function defaultSkillsRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "..", "skills");
}

/**
 * Loads and memoises every `skills/bober.security-<stack>/SKILL.md` file's
 * parsed signatures, once per process (ADR-7: no runtime cache invalidation).
 *
 * Iterates the registry's 8 known stack entries rather than `readdir`-ing
 * the skills directory — that would sweep in `skills/bober.security-audit/`
 * (the orchestration workflow skill, not a stack) and the parser needs a
 * known `stackId` per file anyway.
 */
export class SecurityKnowledgeIndex {
  private cache: Map<SecurityStackId, SecuritySignature[]> | null = null;

  constructor(private readonly skillsRoot: string = defaultSkillsRoot()) {}

  /** Parses all 8 skill files once and memoises. Idempotent — a second call is a no-op. */
  async load(): Promise<void> {
    if (this.cache) return;

    const cache = new Map<SecurityStackId, SecuritySignature[]>();
    for (const { stackId, skillName } of STACK_SKILL_MAP_ENTRIES) {
      const relPath = join(skillName, "SKILL.md");
      let markdown: string;
      try {
        markdown = await readFile(join(this.skillsRoot, relPath), "utf-8");
      } catch {
        // Missing/unreadable skill file -> empty signature set, never throw.
        cache.set(stackId, []);
        continue;
      }
      cache.set(stackId, SecuritySignatureParser.parse(stackId, markdown, relPath));
    }

    this.cache = cache;
  }

  /** That stack's signatures, or [] when missing/before load(). Never throws. */
  forStack(stackId: SecurityStackId): SecuritySignature[] {
    return this.cache?.get(stackId) ?? [];
  }

  /** The union of every stack's signatures. */
  all(): SecuritySignature[] {
    return [...(this.cache?.values() ?? [])].flat();
  }
}
