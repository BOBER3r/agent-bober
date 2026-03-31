/**
 * Verifies that registerAllTools() registers all expected tools.
 */

import { describe, it, expect } from "vitest";

describe("registerAllTools()", () => {
  it("registers exactly 17 tools", async () => {
    const { registerAllTools, getAllTools } = await import("./index.js");
    registerAllTools();
    const tools = getAllTools();
    expect(tools.length).toBe(17);
  });

  it("includes all expected tool names", async () => {
    const { getAllTools } = await import("./index.js");
    const names = getAllTools().map((t) => t.name);
    const expected = [
      "bober_init",
      "bober_plan",
      "bober_sprint",
      "bober_eval",
      "bober_architect",
      "bober_research",
      "bober_run",
      "bober_brownfield",
      "bober_react",
      "bober_solidity",
      "bober_anchor",
      "bober_playwright",
      "bober_status",
      "bober_contracts",
      "bober_spec",
      "bober_principles",
      "bober_config",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it("does not include the removed bober_ping tool", async () => {
    const { getAllTools } = await import("./index.js");
    const names = getAllTools().map((t) => t.name);
    expect(names).not.toContain("bober_ping");
  });
});
