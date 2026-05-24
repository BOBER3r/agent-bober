import { describe, it, expect } from "vitest";
import { AgentGraphPrompts } from "../../src/graph/prompts.js";
import type { BoberAgentRole } from "../../src/graph/preflight-injector.js";

const ROLES: BoberAgentRole[] = [
  "planner",
  "researcher-phase1",
  "researcher-phase2",
  "curator",
  "architect",
  "generator",
  "evaluator",
];

const MODES = ["gated", "dual", "disabled"] as const;

describe("AgentGraphPrompts.fragmentFor — 7 × 3 matrix", () => {
  it("disabled mode is empty for every role", () => {
    for (const role of ROLES) {
      expect(AgentGraphPrompts.fragmentFor(role, "disabled")).toBe("");
    }
  });

  it("planner has no fragment in any mode", () => {
    for (const mode of MODES) {
      expect(AgentGraphPrompts.fragmentFor("planner", mode)).toBe("");
    }
  });

  it("researcher-phase1 has no fragment in any mode", () => {
    for (const mode of MODES) {
      expect(AgentGraphPrompts.fragmentFor("researcher-phase1", mode)).toBe("");
    }
  });

  it("researcher-phase2 gated snapshot", () => {
    expect(AgentGraphPrompts.fragmentFor("researcher-phase2", "gated")).toMatchInlineSnapshot(
      `"For codebase exploration use graph_search, graph_query, graph_review_context, and read_file. Bash, grep, and glob are unavailable for this role."`,
    );
  });

  it("curator gated snapshot", () => {
    expect(AgentGraphPrompts.fragmentFor("curator", "gated")).toMatchInlineSnapshot(
      `"You have graph_search, graph_query, graph_review_context. Use them for ALL exploration. read_file is only for reading specific known files. Prefer graph_query(pattern: "callers_of", target: <symbol>) over grep when looking for who calls a function."`,
    );
  });

  it("architect gated snapshot", () => {
    const frag = AgentGraphPrompts.fragmentFor("architect", "gated");
    expect(frag).toMatchInlineSnapshot(
      `"You have graph_search, graph_query, graph_review_context. Use them for ALL exploration. Prefer graph_query(pattern: "imports_of", target: <symbol>) to map module boundaries and graph_search for high-level structure discovery."`,
    );
    // Sanity checks (independent of exact wording):
    expect(frag).toContain("graph_search");
    expect(frag).toContain("graph_query");
    expect(frag).toContain("graph_review_context");
  });

  it("generator dual snapshot — mentions BOTH grep AND graph_impact", () => {
    const frag = AgentGraphPrompts.fragmentFor("generator", "dual");
    expect(frag).toMatchInlineSnapshot(
      `"You have BOTH grep and graph_* tools. Prefer graph_impact(target: <symbol>) before editing any function with callers. Use grep for line-precise edits and known-file inspection."`,
    );
    expect(frag).toContain("grep");
    expect(frag).toContain("graph_impact");
  });

  it("evaluator dual snapshot", () => {
    const frag = AgentGraphPrompts.fragmentFor("evaluator", "dual");
    expect(frag).toContain("grep");
    expect(frag).toMatch(/graph_(changes|impact|search|query)/);
  });

  it("curator gated must forbid grep for exploration", () => {
    const frag = AgentGraphPrompts.fragmentFor("curator", "gated");
    // Per s7-c3: 'Use them for ALL exploration' + grep relegated to symbol-lookup only.
    expect(frag.toLowerCase()).toContain("all exploration");
  });
});

describe("AgentGraphPrompts.decorate — integration", () => {
  it("returns base unchanged when graph disabled", () => {
    const base = "AGENT BASE PROMPT";
    expect(
      AgentGraphPrompts.decorate("curator", base, { graphEnabled: false, engineHealth: "ready" }),
    ).toBe(base);
  });

  it("returns base unchanged when engine not ready", () => {
    const base = "AGENT BASE PROMPT";
    expect(
      AgentGraphPrompts.decorate("curator", base, { graphEnabled: true, engineHealth: "starting" }),
    ).toBe(base);
  });

  it("returns base unchanged for planner even when graph enabled and ready", () => {
    const base = "PLANNER BASE";
    expect(
      AgentGraphPrompts.decorate("planner", base, { graphEnabled: true, engineHealth: "ready" }),
    ).toBe(base);
  });

  it("appends fragment with \\n\\n---\\n\\n separator when curator is gated", () => {
    const base = "CURATOR BASE";
    const decorated = AgentGraphPrompts.decorate("curator", base, {
      graphEnabled: true,
      engineHealth: "ready",
    });
    expect(decorated.startsWith(base + "\n\n---\n\n")).toBe(true);
    expect(decorated.endsWith(AgentGraphPrompts.fragmentFor("curator", "gated"))).toBe(true);
  });

  it("generator/evaluator use 'dual' mode even though their tool surface is UNION", () => {
    const decorated = AgentGraphPrompts.decorate("generator", "G", {
      graphEnabled: true,
      engineHealth: "ready",
    });
    expect(decorated).toContain("BOTH");
  });
});
