/**
 * Skill bundle tests for the 3 new graph skills.
 *
 * Verifies:
 * - Each SKILL.md exists and has correct frontmatter shape (s10-c7)
 * - bober.impact has argument-hint: <symbol|file> (s10-c7)
 * - src/cli/commands/init.ts includes all 3 skills in UNIVERSAL_COMMANDS (s10-c8)
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const skillsRoot = join(repoRoot, "skills");

// ── YAML frontmatter parser ───────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    } else if (key && !value) {
      // Could be start of a block (like handoffs:) — skip for simplicity
    }
  }
  return result;
}

// ── Skill existence and frontmatter ──────────────────────────────────────────

const SKILL_FIXTURES: Array<{
  dir: string;
  expectedName: string;
  hasArgumentHint: boolean;
  argumentHintValue?: string;
}> = [
  {
    dir: "bober.graph",
    expectedName: "bober.graph",
    hasArgumentHint: false,
  },
  {
    dir: "bober.onboard",
    expectedName: "bober.onboard",
    hasArgumentHint: false,
  },
  {
    dir: "bober.impact",
    expectedName: "bober.impact",
    hasArgumentHint: true,
    argumentHintValue: "<symbol|file>",
  },
];

describe("Skill bundles — frontmatter shape", () => {
  for (const fixture of SKILL_FIXTURES) {
    it(`${fixture.dir}/SKILL.md exists`, async () => {
      const path = join(skillsRoot, fixture.dir, "SKILL.md");
      const content = await readFile(path, "utf-8");
      expect(content.length).toBeGreaterThan(0);
    });

    it(`${fixture.dir}/SKILL.md has required frontmatter fields`, async () => {
      const path = join(skillsRoot, fixture.dir, "SKILL.md");
      const content = await readFile(path, "utf-8");

      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/\n---/);

      const fm = parseFrontmatter(content);
      expect(typeof fm.name).toBe("string");
      expect(fm.name).toBe(fixture.expectedName);
      expect(typeof fm.description).toBe("string");
      expect((fm.description as string).length).toBeGreaterThan(10);
    });

    if (fixture.hasArgumentHint) {
      it(`${fixture.dir}/SKILL.md has correct argument-hint`, async () => {
        const path = join(skillsRoot, fixture.dir, "SKILL.md");
        const content = await readFile(path, "utf-8");
        expect(content).toContain(`argument-hint: ${fixture.argumentHintValue}`);
      });
    }

    it(`${fixture.dir}/SKILL.md body describes the CLI workflow`, async () => {
      const path = join(skillsRoot, fixture.dir, "SKILL.md");
      const content = await readFile(path, "utf-8");
      // Body must reference the CLI subcommand
      const expectedCmd = fixture.dir.replace(".", "-");
      expect(content).toContain(`agent-bober ${expectedCmd.replace("bober-", "")}`);
    });
  }
});

// ── init.ts skill inclusion ───────────────────────────────────────────────────

describe("init.ts — UNIVERSAL_COMMANDS includes all 3 new skills", () => {
  it("includes bober.graph", async () => {
    const initSrc = await readFile(
      join(repoRoot, "src", "cli", "commands", "init.ts"),
      "utf-8",
    );
    expect(initSrc).toContain('"bober.graph"');
  });

  it("includes bober.onboard", async () => {
    const initSrc = await readFile(
      join(repoRoot, "src", "cli", "commands", "init.ts"),
      "utf-8",
    );
    expect(initSrc).toContain('"bober.onboard"');
  });

  it("includes bober.impact", async () => {
    const initSrc = await readFile(
      join(repoRoot, "src", "cli", "commands", "init.ts"),
      "utf-8",
    );
    expect(initSrc).toContain('"bober.impact"');
  });

  it("all 3 are in the UNIVERSAL_COMMANDS set (not stack-specific)", async () => {
    const initSrc = await readFile(
      join(repoRoot, "src", "cli", "commands", "init.ts"),
      "utf-8",
    );
    // The UNIVERSAL_COMMANDS set should contain the 3 new skills
    const universalMatch = /const UNIVERSAL_COMMANDS = new Set<string>\(\[([\s\S]*?)\]\)/.exec(initSrc);
    expect(universalMatch).not.toBeNull();
    const universalBlock = universalMatch![1];
    expect(universalBlock).toContain('"bober.graph"');
    expect(universalBlock).toContain('"bober.onboard"');
    expect(universalBlock).toContain('"bober.impact"');
  });

  it("skillMap includes all 3 new entries", async () => {
    const initSrc = await readFile(
      join(repoRoot, "src", "cli", "commands", "init.ts"),
      "utf-8",
    );
    expect(initSrc).toContain('"bober.graph": "bober-graph.md"');
    expect(initSrc).toContain('"bober.onboard": "bober-onboard.md"');
    expect(initSrc).toContain('"bober.impact": "bober-impact.md"');
  });
});

// ── Version bump ──────────────────────────────────────────────────────────────

describe("package.json version", () => {
  it("is a valid semver string", async () => {
    const pkg = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf-8"),
    ) as { version: string };
    // Shape check, not a hardcoded pin — a pinned value turns every release
    // bump into a test failure (it broke at 0.14.0 → 0.15.0 → 0.16.0 → 0.17.0).
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

// ── CHANGELOG ────────────────────────────────────────────────────────────────

describe("CHANGELOG.md", () => {
  it("has a 0.14.0 entry", async () => {
    const changelog = await readFile(join(repoRoot, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("## [0.14.0]");
  });

  it("retains the 0.13.0 entry (history is append-only)", async () => {
    const changelog = await readFile(join(repoRoot, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("## [0.13.0]");
  });

  it("mentions the KPI gate result", async () => {
    const changelog = await readFile(join(repoRoot, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("KPI gate result");
    expect(changelog).toContain("60%");
  });

  it("mentions the new commands", async () => {
    const changelog = await readFile(join(repoRoot, "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("graph [init|sync|status]");
    expect(changelog).toContain("agent-bober onboard");
    expect(changelog).toContain("agent-bober impact");
  });
});
