import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolveLensFocus } from "./eval-lenses.js";

// ── Lens-panel drift gate ──────────────────────────────────────────

const BUILT_IN_LENSES = ["correctness", "security", "regression", "quality", "simplicity"] as const;

describe("lens-panel.md drift gate", () => {
  it("embeds every resolveLensFocus fragment verbatim", async () => {
    const md = await readFile(
      new URL("../../skills/shared/lens-panel.md", import.meta.url),
      "utf-8",
    );
    for (const lens of BUILT_IN_LENSES) {
      expect(md).toContain(resolveLensFocus(lens));
    }
  });
});

// ── Evaluator agent copy sync gate ─────────────────────────────────

describe("bober-evaluator.md agent-copy sync gate", () => {
  it("keeps agents/ and .claude/agents/ copies byte-identical", async () => {
    const source = await readFile(
      new URL("../../agents/bober-evaluator.md", import.meta.url),
      "utf-8",
    );
    const claudeCopy = await readFile(
      new URL("../../.claude/agents/bober-evaluator.md", import.meta.url),
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

describe("per-skill lens-panel.md reference copy parity", () => {
  const SKILL_DIRS = ["bober.run", "bober.sprint", "bober.eval"] as const;

  for (const skillDir of SKILL_DIRS) {
    it(`skills/${skillDir}/references/lens-panel.md is byte-identical to skills/shared/lens-panel.md`, async () => {
      const canonical = await readFile(
        new URL("../../skills/shared/lens-panel.md", import.meta.url),
        "utf-8",
      );
      const copy = await readFile(
        new URL(`../../skills/${skillDir}/references/lens-panel.md`, import.meta.url),
        "utf-8",
      );
      expect(copy).toBe(canonical);
    });
  }
});

// ── Command recomputation parity gate ──────────────────────────────

describe("bober-{run,sprint,eval}.md command recomputation parity", () => {
  const SKILL_COMMAND_MAP = [
    { skillDir: "bober.run", cmdFile: "bober-run.md" },
    { skillDir: "bober.sprint", cmdFile: "bober-sprint.md" },
    { skillDir: "bober.eval", cmdFile: "bober-eval.md" },
  ] as const;

  for (const { skillDir, cmdFile } of SKILL_COMMAND_MAP) {
    it(`.claude/commands/${cmdFile} equals recomputed inline of skills/${skillDir}`, async () => {
      const recomputed = await recomputeCommand(skillDir);
      const committed = await readFile(
        new URL(`../../.claude/commands/${cmdFile}`, import.meta.url),
        "utf-8",
      );
      expect(committed).toBe(recomputed);
    });
  }
});
