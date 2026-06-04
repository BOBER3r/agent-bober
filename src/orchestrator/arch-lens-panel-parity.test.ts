import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveArchLensFocus } from "./arch-lenses.js";

// ── Arch-lens-panel drift gate ─────────────────────────────────────

const BUILT_IN_ARCH_LENSES = [
  "scalability",
  "security",
  "cost",
  "operability",
  "maintainability",
  "reversibility",
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
