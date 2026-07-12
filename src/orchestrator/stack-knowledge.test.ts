import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { resolveStackSecurityContext, ALL_VULN_CLASSES } from "./stack-knowledge.js";
import { resolveLensFocus } from "./eval-lenses.js";

// ── Fixture ───────────────────────────────────────────────────────────

let skillsRoot: string;

beforeEach(async () => {
  skillsRoot = await mkdtemp(join(tmpdir(), "bober-stack-knowledge-test-"));
});

afterEach(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<void> {
  const dir = join(skillsRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf-8");
}

const genericFragment = resolveLensFocus("security");

// ── Tests ─────────────────────────────────────────────────────────────

describe("resolveStackSecurityContext — stack → skill mapping", () => {
  it("maps 'solidity' stack to bober.solidity and reads its Security Checklist section", async () => {
    await writeSkill(
      "bober.solidity",
      [
        "# Solidity Skill",
        "",
        "## Step 1: Project Assessment",
        "",
        "irrelevant setup content",
        "",
        "## Security Checklist",
        "",
        "1. **Reentrancy:** external calls before state updates.",
        "2. **Access control:** missing role checks.",
        "",
        "## Next Steps",
        "",
        "irrelevant trailer content",
      ].join("\n"),
    );

    const ctx = await resolveStackSecurityContext("solidity", skillsRoot);

    expect(ctx.skillName).toBe("bober.solidity");
    expect(ctx.stackLabel).toBe("solidity");
    expect(ctx.promptFragment).toContain("Security Checklist");
    expect(ctx.promptFragment).toContain("Reentrancy");
    // Bounded excerpt — must not include unrelated trailing sections.
    expect(ctx.promptFragment).not.toContain("irrelevant trailer content");
    expect(ctx.promptFragment).not.toContain("irrelevant setup content");
    // Generic taxonomy backbone is always appended.
    expect(ctx.promptFragment).toContain(genericFragment);
    expect(ctx.taxonomy).toEqual(ALL_VULN_CLASSES);
  });

  it("maps 'anchor' stack to bober.anchor, falling back to a bounded head excerpt when no security heading exists", async () => {
    await writeSkill(
      "bober.anchor",
      [
        "# Anchor Skill",
        "",
        "## When to Use This Skill",
        "",
        "Use this for Solana Anchor programs.",
        "",
        "## Step 5: Execute the Pipeline",
        "",
        "### Anchor-Specific Evaluation Enhancements",
        "",
        "Account validation, PDA correctness, CPI safety.",
      ].join("\n"),
    );

    const ctx = await resolveStackSecurityContext({ blockchain: "anchor" }, skillsRoot);

    expect(ctx.skillName).toBe("bober.anchor");
    expect(ctx.stackLabel).toBe("anchor");
    expect(ctx.promptFragment).toContain("Anchor Skill");
    expect(ctx.promptFragment).toContain(genericFragment);
  });

  it("maps 'react' stack to bober.react, falling back to generic taxonomy when the skill has no security section", async () => {
    await writeSkill(
      "bober.react",
      ["# React Skill", "", "## When to Use This Skill", "", "Use for React frontends."].join("\n"),
    );

    const ctx = await resolveStackSecurityContext({ frontend: "react" }, skillsRoot);

    expect(ctx.skillName).toBe("bober.react");
    expect(ctx.stackLabel).toBe("react");
    expect(ctx.promptFragment).toContain(genericFragment);
  });

  it("returns {skillName:null} with the generic taxonomy for an unknown stack", async () => {
    const ctx = await resolveStackSecurityContext({ frontend: "vue" }, skillsRoot);

    expect(ctx.skillName).toBeNull();
    expect(ctx.promptFragment).toBe(genericFragment);
    expect(ctx.taxonomy).toEqual(ALL_VULN_CLASSES);
  });

  it("returns {skillName:null} with the generic taxonomy for an absent stack", async () => {
    const ctx = await resolveStackSecurityContext(undefined, skillsRoot);

    expect(ctx.skillName).toBeNull();
    expect(ctx.stackLabel).toBe("unknown");
    expect(ctx.promptFragment).toBe(genericFragment);
  });

  it("degrades to {skillName:null} without throwing when the matched skill file is missing", async () => {
    // skillsRoot is empty — no bober.solidity/SKILL.md present.
    await expect(resolveStackSecurityContext("solidity", skillsRoot)).resolves.toEqual({
      stackLabel: "solidity",
      skillName: null,
      taxonomy: ALL_VULN_CLASSES,
      promptFragment: genericFragment,
    });
  });

  it("never throws when skillsRoot itself does not exist", async () => {
    await expect(
      resolveStackSecurityContext("solidity", join(skillsRoot, "does-not-exist")),
    ).resolves.toMatchObject({ skillName: null });
  });

  it("prefers blockchain/language fields over frontend when both are present on a Stack object", async () => {
    await writeSkill("bober.solidity", "## Security Checklist\n\nReentrancy checks.");

    const ctx = await resolveStackSecurityContext(
      { frontend: "react", blockchain: "solidity" },
      skillsRoot,
    );

    expect(ctx.skillName).toBe("bober.solidity");
  });

  it("resolves without a skillsRoot override using the bundled package skills/ directory", async () => {
    // No override — exercises the default packageRoot/skills resolution path
    // against the real repository's skills/bober.solidity/SKILL.md.
    const ctx = await resolveStackSecurityContext("solidity");

    expect(ctx.skillName).toBe("bober.solidity");
    expect(ctx.promptFragment).toContain(genericFragment);
  });
});
