/**
 * Co-located smoke tests for src/graph/prompts.ts (ADR-5).
 *
 * Fast structural checks: module loads, types are stable, public API
 * returns expected types. Full snapshot and integration tests live at
 * tests/graph/prompts.test.ts.
 */

import { describe, it, expect } from "vitest";
import { AgentGraphPrompts } from "./prompts.js";

describe("AgentGraphPrompts — module-load smoke tests", () => {
  it("fragmentFor returns a string for all modes", () => {
    expect(typeof AgentGraphPrompts.fragmentFor("researcher-phase2", "gated")).toBe("string");
    expect(typeof AgentGraphPrompts.fragmentFor("curator", "gated")).toBe("string");
    expect(typeof AgentGraphPrompts.fragmentFor("planner", "disabled")).toBe("string");
  });

  it("decorate returns base unchanged when graph is disabled", () => {
    const base = "BASE";
    expect(AgentGraphPrompts.decorate("curator", base, { graphEnabled: false, engineHealth: "ready" })).toBe(base);
  });

  it("decorate appends separator + fragment when conditions met", () => {
    const base = "BASE";
    const out = AgentGraphPrompts.decorate("curator", base, { graphEnabled: true, engineHealth: "ready" });
    expect(out.startsWith("BASE\n\n---\n\n")).toBe(true);
    expect(out.length).toBeGreaterThan(base.length);
  });
});
