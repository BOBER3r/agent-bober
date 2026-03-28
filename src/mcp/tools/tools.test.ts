/**
 * Verifies that registerAllTools() registers exactly 10 tools.
 */

import { describe, it, expect } from "vitest";

// We need a fresh registry for each test to avoid contamination from
// the module-scoped singleton. We do this by re-importing with dynamic imports
// and clearing state manually. Instead, we test the exported registry
// directly by counting after registration.

describe("registerAllTools()", () => {
  it("registers exactly 10 tools", async () => {
    // Dynamic import ensures we get a clean module scope for the registry.
    // Use a side-effect-free import of the registry, then check the count
    // after calling registerAllTools.
    const { registerAllTools, getAllTools } = await import("./index.js");
    registerAllTools();
    const tools = getAllTools();
    expect(tools.length).toBe(10);
  });

  it("includes all expected tool names", async () => {
    const { getAllTools } = await import("./index.js");
    const names = getAllTools().map((t) => t.name);
    const expected = [
      "bober_init",
      "bober_plan",
      "bober_sprint",
      "bober_eval",
      "bober_run",
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
