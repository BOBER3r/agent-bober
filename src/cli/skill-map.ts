import { readdir } from "node:fs/promises";

/**
 * Enumerate every `bober.*` skill directory under `skillsRoot` and map it to
 * its inlined command filename (`bober.code-review` -> `bober-code-review.md`).
 *
 * Derived at runtime from the skills/ directory so this can never drift the
 * way a manually-maintained list did (see git history on installClaudeCommands
 * in cli/commands/init.ts) — every skills/bober.X directory is picked up
 * automatically, with no list to forget to update.
 *
 * Shared by `installClaudeCommands` (cli/commands/init.ts) and
 * scripts/update-all.mjs so both stay byte-identical by construction.
 */
export async function buildSkillMap(skillsRoot: string): Promise<Record<string, string>> {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const map: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("bober.")) continue;
    map[entry.name] = `${entry.name.replace(/\./g, "-")}.md`;
  }
  return map;
}
