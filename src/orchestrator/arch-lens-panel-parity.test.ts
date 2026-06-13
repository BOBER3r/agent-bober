import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolveArchLensFocus } from "./arch-lenses.js";

// ── Arch-lens-panel drift gate ─────────────────────────────────────

const BUILT_IN_ARCH_LENSES = [
  "scalability",
  "security",
  "cost",
  "operability",
  "maintainability",
  "reversibility",
  "simplicity",
] as const;

describe("arch-lens-panel.md drift gate", () => {
  it("embeds every resolveArchLensFocus fragment verbatim", async () => {
    const md = await readFile(
      new URL("../../skills/shared/arch-lens-panel.md", import.meta.url),
      "utf-8",
    );
    for (const lens of BUILT_IN_ARCH_LENSES) {
      expect(md).toContain(resolveArchLensFocus(lens));
    }
  });
});

// ── Architect agent copy sync gate ────────────────────────────────

describe("bober-architect.md agent-copy sync gate", () => {
  it("keeps agents/ and .claude/agents/ copies byte-identical", async () => {
    const source = await readFile(
      new URL("../../agents/bober-architect.md", import.meta.url),
      "utf-8",
    );
    const claudeCopy = await readFile(
      new URL("../../.claude/agents/bober-architect.md", import.meta.url),
      "utf-8",
    );
    expect(claudeCopy).toBe(source);
  });
});

// ── Per-skill reference copy parity gate ───────────────────────────

async function recomputeCommand(skillDir: string): Promise<string> {
  const root = new URL("../../", import.meta.url);
  let content = await readFile(new URL(`skills/${skillDir}/SKILL.md`, root), "utf-8");
  const refsDir = new URL(`skills/${skillDir}/references/`, root);
  let refFiles: string[];
  try {
    refFiles = await readdir(refsDir);
  } catch {
    refFiles = [];
  }
  for (const refFile of refFiles.sort()) {
    if (!refFile.endsWith(".md")) continue;
    const refContent = await readFile(new URL(refFile, refsDir), "utf-8");
    content += `\n\n---\n\n<!-- Reference: ${refFile} -->\n\n${refContent}`;
  }
  return content;
}

describe("bober.architect references/arch-lens-panel.md reference copy parity", () => {
  it("skills/bober.architect/references/arch-lens-panel.md is byte-identical to skills/shared/arch-lens-panel.md", async () => {
    const canonical = await readFile(
      new URL("../../skills/shared/arch-lens-panel.md", import.meta.url),
      "utf-8",
    );
    const copy = await readFile(
      new URL("../../skills/bober.architect/references/arch-lens-panel.md", import.meta.url),
      "utf-8",
    );
    expect(copy).toBe(canonical);
  });
});

// ── Command recomputation parity gate ──────────────────────────────

describe("bober-architect.md command recomputation parity", () => {
  it(".claude/commands/bober-architect.md equals recomputed inline of skills/bober.architect", async () => {
    const recomputed = await recomputeCommand("bober.architect");
    const committed = await readFile(
      new URL("../../.claude/commands/bober-architect.md", import.meta.url),
      "utf-8",
    );
    expect(committed).toBe(recomputed);
  });
});
