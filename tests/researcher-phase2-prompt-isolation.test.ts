/**
 * Researcher-Phase2 PROMPT FRAGMENT Isolation Invariant (s7-c2)
 *
 * The Researcher-Phase2 'gated' prompt fragment MUST be a literal string with
 * zero interpolation, zero feature/task/sprint references, zero template
 * placeholders. This test pins the EXACT bytes of the fragment.
 *
 * Any change to RESEARCHER_PHASE2_GATED requires a deliberate snapshot update
 * with reviewer acknowledgment (ADR-5).
 */
import { describe, it, expect } from "vitest";
import { AgentGraphPrompts } from "../src/graph/prompts.js";

describe("Researcher-Phase2 prompt-fragment isolation invariant", () => {
  it("exact literal bytes of the gated fragment", () => {
    const fragment = AgentGraphPrompts.fragmentFor("researcher-phase2", "gated");

    // Pin the exact string. ANY edit forces this test to fail.
    expect(fragment).toBe(
      "For codebase exploration use graph_search, graph_query, graph_review_context, and read_file. Bash, grep, and glob are unavailable for this role.",
    );
  });

  it("contains no template-placeholder syntax", () => {
    const fragment = AgentGraphPrompts.fragmentFor("researcher-phase2", "gated");
    expect(fragment).not.toMatch(/\$\{/); // no ${...}
    expect(fragment).not.toMatch(/\{\{/); // no {{ }}
    expect(fragment).not.toMatch(/<[A-Z_]+>/); // no <PLACEHOLDER>
  });

  it("contains no feature/task/sprint vocabulary", () => {
    const fragment = AgentGraphPrompts.fragmentFor("researcher-phase2", "gated");
    const forbidden = ["feature", "task", "sprint", "contract", "title", "description"];
    for (const word of forbidden) {
      expect(fragment.toLowerCase()).not.toContain(word);
    }
  });

  it("does not leak feature text when wrapped through decorate()", () => {
    // decorate() must not interpolate any caller-provided text into the fragment.
    // Mirror the mutation-style assurance from tests/researcher-phase2-isolation.test.ts.
    const decorated = AgentGraphPrompts.decorate(
      "researcher-phase2",
      "BASE_SYSTEM_PROMPT_XYZAB",
      { graphEnabled: true, engineHealth: "ready" },
    );
    // The base appears (it's the prefix), but the fragment portion (after \n\n---\n\n)
    // must not contain the sentinel.
    const sep = "\n\n---\n\n";
    const idx = decorated.lastIndexOf(sep);
    expect(idx).toBeGreaterThan(0);
    const fragmentPortion = decorated.slice(idx + sep.length);
    expect(fragmentPortion).not.toContain("XYZAB");
  });
});
