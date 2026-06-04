import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveLensFocus } from "./eval-lenses.js";

// ── Lens-panel drift gate ──────────────────────────────────────────

const BUILT_IN_LENSES = ["correctness", "security", "regression", "quality"] as const;

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
