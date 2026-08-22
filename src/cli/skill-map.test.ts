/**
 * buildSkillMap is the single implementation shared by installClaudeCommands
 * (cli/commands/init.ts) and scripts/update-all.mjs, replacing a hardcoded
 * skill-dir → command-file map that had drifted to 24 of 45 real skills/
 * directories. These tests guard against that regression: the second test
 * compares against the actual skills/ directory rather than a hardcoded
 * count, so it stays valid as skills are added or removed.
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSkillMap } from "./skill-map.js";

const REPO_SKILLS_ROOT = join(process.cwd(), "skills");

describe("buildSkillMap", () => {
  it("maps each bober.* directory to its inlined command filename, ignoring non-matching entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-map-"));
    try {
      await mkdir(join(dir, "bober.code-review"));
      await mkdir(join(dir, "bober.plan"));
      await mkdir(join(dir, "not-a-skill")); // no "bober." prefix — must be ignored
      await writeFile(join(dir, "bober.loose-file.md"), "x"); // not a directory — must be ignored

      const map = await buildSkillMap(dir);

      expect(map).toEqual({
        "bober.code-review": "bober-code-review.md",
        "bober.plan": "bober-plan.md",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enumerates every bober.* directory that actually exists in skills/ (regression guard for the stale hardcoded map)", async () => {
    const onDisk = (await readdir(REPO_SKILLS_ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith("bober."))
      .map((e) => e.name)
      .sort();

    // Sanity: the fixture assumption itself (catches a misconfigured cwd).
    expect(onDisk.length).toBeGreaterThan(0);

    const map = await buildSkillMap(REPO_SKILLS_ROOT);
    expect(Object.keys(map).sort()).toEqual(onDisk);
  });
});
