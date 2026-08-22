/**
 * Regression coverage for the stale-skillMap bug: installClaudeCommands used
 * to install only 24 of the 45 real skills/ directories (and a hardcoded
 * agents/ list that had drifted the same way) because the map was a
 * manually-maintained literal instead of derived from disk. Fixed by
 * buildSkillMap (skill-map.ts) plus defaulting unclassified skills to
 * "universal" in installClaudeCommands' shouldInstall gate.
 *
 * These tests compare against the real skills/ and agents/ directories
 * rather than a hardcoded count, so they can't themselves go stale.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

async function allSkillDirs(): Promise<string[]> {
  const entries = await readdir(join(REPO_ROOT, "skills"), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith("bober."))
    .map((e) => e.name);
}

async function allAgentFiles(): Promise<string[]> {
  const entries = await readdir(join(REPO_ROOT, "agents"));
  return entries.filter((f) => f.endsWith(".md"));
}

describe("installClaudeCommands", () => {
  it("greenfield with no preset installs every skill in skills/ and every agent in agents/", async () => {
    const { installClaudeCommands } = await import("./init.js");
    const projectRoot = await mkdtemp(join(tmpdir(), "install-claude-commands-"));
    try {
      await installClaudeCommands(projectRoot, "greenfield", undefined);

      const [installedCommands, installedAgents, skills, agents] = await Promise.all([
        readdir(join(projectRoot, ".claude", "commands")),
        readdir(join(projectRoot, ".claude", "agents")),
        allSkillDirs(),
        allAgentFiles(),
      ]);

      expect(installedCommands.sort()).toEqual(
        skills.map((s) => `${s.replace(/\./g, "-")}.md`).sort(),
      );
      expect(installedAgents.sort()).toEqual(agents.sort());
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("brownfield installs a previously-unclassified skill (bober.seo) that the old hardcoded map silently dropped", async () => {
    const { installClaudeCommands } = await import("./init.js");
    const projectRoot = await mkdtemp(join(tmpdir(), "install-claude-commands-"));
    try {
      await installClaudeCommands(projectRoot, "brownfield", undefined);
      const installedCommands = await readdir(join(projectRoot, ".claude", "commands"));

      // bober.seo was absent from the old hardcoded skillMap entirely — it
      // couldn't be installed under ANY mode, not just brownfield.
      expect(installedCommands).toContain("bober-seo.md");
      // Every agent still ships regardless of mode (agents aren't stack-gated).
      const installedAgents = await readdir(join(projectRoot, ".claude", "agents"));
      expect(installedAgents.sort()).toEqual((await allAgentFiles()).sort());
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("brownfield still excludes stack-gated skills (react/solidity/anchor) — curation is preserved, not blanket-installed", async () => {
    const { installClaudeCommands } = await import("./init.js");
    const projectRoot = await mkdtemp(join(tmpdir(), "install-claude-commands-"));
    try {
      await installClaudeCommands(projectRoot, "brownfield", undefined);
      const installedCommands = await readdir(join(projectRoot, ".claude", "commands"));

      expect(installedCommands).not.toContain("bober-react.md");
      expect(installedCommands).not.toContain("bober-solidity.md");
      expect(installedCommands).not.toContain("bober-anchor.md");
      // ...but the mode-appropriate stack-gated ones are still there.
      expect(installedCommands).toContain("bober-brownfield.md");
      expect(installedCommands).toContain("bober-playwright.md");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("greenfield with a preset that doesn't match react/solidity/anchor still excludes them", async () => {
    const { installClaudeCommands } = await import("./init.js");
    const projectRoot = await mkdtemp(join(tmpdir(), "install-claude-commands-"));
    try {
      await installClaudeCommands(projectRoot, "greenfield", "nextjs");
      const installedCommands = await readdir(join(projectRoot, ".claude", "commands"));

      expect(installedCommands).toContain("bober-react.md"); // nextjs IS a react target
      expect(installedCommands).not.toContain("bober-solidity.md");
      expect(installedCommands).not.toContain("bober-anchor.md");
      // A previously-unclassified skill is still universal under a preset too.
      expect(installedCommands).toContain("bober-seo.md");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
