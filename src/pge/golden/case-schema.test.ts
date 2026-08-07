import { describe, expect, it } from "vitest";

import {
  GOLDEN_CASE_FORMAT_VERSION,
  GOLDEN_DATASET_MAX_CASES,
  GOLDEN_DATASET_MIN_CASES,
  GoldenCaseSchema,
  checkCaseAgainstGraph,
  isCanonicalArtifacts,
  isReplayCase,
  majorVersion,
  parseGoldenCase,
} from "./case-schema.js";
import type { GoldenGraphFacts } from "./case-schema.js";

/**
 * Every refinement in the schema is driven from BOTH sides here.
 *
 * A schema test that only parses valid input proves the schema accepts, never that it
 * rejects — and a case schema that cannot reject is a schema that lets a malformed case sit
 * in the dataset claiming to pin something. Each negative below breaks exactly one rule.
 */

// ── A valid case, and one-field mutations of it ─────────────────────

function validCase(): Record<string, unknown> {
  return {
    formatVersion: GOLDEN_CASE_FORMAT_VERSION,
    caseId: "fixture-case",
    title: "A fixture case",
    intent: "Pin the schema's own happy path.",
    tags: ["fixture"],
    enforcement: "replay",
    graph: { graphId: "coding", graphVersion: "1.2.0" },
    input: { featureRequest: "Do the thing.", entryNodeId: "research_body" },
    pinnedResponses: [
      {
        nodeId: "research_reflect",
        branchKey: null,
        effectName: "research.reflect",
        callIndex: 0,
        request: { featureRequest: "Do the thing." },
        response: { coreProblem: "The thing is not done." },
      },
    ],
    expected: {
      terminalNodeId: "research_collect",
      artifacts: { contracts: [{ contractId: "c-1", status: "passed" }] },
      notes: "One contract, canonical.",
    },
  };
}

/** The valid case with `mutate` applied to a deep clone. */
function mutated(mutate: (draft: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = JSON.parse(JSON.stringify(validCase())) as Record<string, unknown>;
  mutate(draft);
  return draft;
}

describe("GoldenCaseSchema", () => {
  it("parses a well-formed case", () => {
    const result = parseGoldenCase(validCase(), "fixture-case.json");
    expect(result.ok).toBe(true);
  });

  it("keeps the dataset bounds the contract names", () => {
    expect(GOLDEN_DATASET_MIN_CASES).toBe(20);
    expect(GOLDEN_DATASET_MAX_CASES).toBe(50);
  });

  it("prefixes every issue with the source file", () => {
    const result = parseGoldenCase(mutated((d) => (d.caseId = "Not Kebab")), "bad.json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.every((e) => e.startsWith("bad.json:"))).toBe(true);
  });

  // ── Negative controls, one rule each ──

  it("rejects an unknown top-level key", () => {
    const result = GoldenCaseSchema.safeParse(mutated((d) => (d.engine = "pge")));
    expect(result.success).toBe(false);
  });

  it("rejects a caseId that is not kebab-case", () => {
    expect(GoldenCaseSchema.safeParse(mutated((d) => (d.caseId = "Not Kebab"))).success).toBe(false);
    expect(GoldenCaseSchema.safeParse(mutated((d) => (d.caseId = "trailing-"))).success).toBe(false);
  });

  /**
   * `enforcement` is REQUIRED and has no default, and this is the test that keeps it that
   * way. Both defaults are wrong: defaulting to `integrity` lets a captured case silently
   * stop being executed, and defaulting to `replay` lets a curated case fail for a claim
   * its author never made. So a case that does not say is not a case.
   */
  it("rejects a case that does not declare how it is enforced", () => {
    const result = GoldenCaseSchema.safeParse(mutated((d) => delete d.enforcement));
    expect(result.success).toBe(false);
    expect(parseGoldenCase(mutated((d) => delete d.enforcement), "x").ok).toBe(false);
  });

  it("rejects an enforcement the runner does not know how to honour", () => {
    expect(GoldenCaseSchema.safeParse(mutated((d) => (d.enforcement = "advisory"))).success).toBe(
      false,
    );
    expect(GoldenCaseSchema.safeParse(mutated((d) => (d.enforcement = true))).success).toBe(false);
  });

  it("classifies a case by what it declares, not by what it looks like", () => {
    const replay = GoldenCaseSchema.parse(validCase());
    expect(isReplayCase(replay)).toBe(true);
    const curated = GoldenCaseSchema.parse(mutated((d) => (d.enforcement = "integrity")));
    expect(isReplayCase(curated)).toBe(false);
  });

  it("rejects an unknown formatVersion", () => {
    expect(GoldenCaseSchema.safeParse(mutated((d) => (d.formatVersion = 2))).success).toBe(false);
  });

  it("rejects a graphVersion that is not MAJOR.MINOR.PATCH", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => ((d.graph as Record<string, unknown>).graphVersion = "1.2")),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a case that pins no response at all", () => {
    expect(GoldenCaseSchema.safeParse(mutated((d) => (d.pinnedResponses = []))).success).toBe(false);
  });

  it("rejects two pinned responses with the same recording key", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const pinned = d.pinnedResponses as Record<string, unknown>[];
        pinned.push({ ...pinned[0], response: { coreProblem: "a different answer" } });
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes("duplicate recording key"))).toBe(
      true,
    );
  });

  it("rejects a callIndex sequence with a hole in it", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const pinned = d.pinnedResponses as Record<string, unknown>[];
        pinned.push({ ...pinned[0], callIndex: 2 });
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes("contiguous from 0"))).toBe(true);
  });

  it("accepts a contiguous multi-call sequence on one node", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const pinned = d.pinnedResponses as Record<string, unknown>[];
        pinned.push({ ...pinned[0], callIndex: 1 });
      }),
    );
    expect(result.success).toBe(true);
  });

  it("counts callIndex per branch, so two branches may both start at 0", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const pinned = d.pinnedResponses as Record<string, unknown>[];
        pinned.push({ ...pinned[0], branchKey: "branch-2" });
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an expectation carrying a volatile key", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const expected = d.expected as Record<string, unknown>;
        expected.artifacts = { contracts: [{ contractId: "c-1", createdAt: "2026-08-05T00:00:00Z" }] };
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes("not canonical"))).toBe(true);
  });

  it("rejects an expectation whose nested keys are not sorted", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const expected = d.expected as Record<string, unknown>;
        // status before contractId — the same content, a non-canonical spelling of it.
        expected.artifacts = { contracts: [{ status: "passed", contractId: "c-1" }] };
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unknown artifact field", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const expected = d.expected as Record<string, unknown>;
        expected.artifacts = { contract: [{ contractId: "c-1" }] };
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a scalar field pinned with two elements", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const expected = d.expected as Record<string, unknown>;
        expected.artifacts = { progress: ["# Progress", "# Progress again"] };
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes("scalar field"))).toBe(true);
  });

  it("accepts a scalar field pinned with one element", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const expected = d.expected as Record<string, unknown>;
        expected.artifacts = { progress: ["# Progress"] };
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts an empty artifact map — the claim that nothing visible was written", () => {
    const result = GoldenCaseSchema.safeParse(
      mutated((d) => {
        const expected = d.expected as Record<string, unknown>;
        expected.artifacts = {};
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("isCanonicalArtifacts", () => {
  it("accepts sorted, volatile-free content", () => {
    expect(isCanonicalArtifacts({ contracts: [{ contractId: "c-1", status: "passed" }] })).toBe(true);
  });

  it("rejects a volatile key and unsorted keys alike", () => {
    expect(isCanonicalArtifacts({ contracts: [{ contractId: "c", runId: "r" }] })).toBe(false);
    expect(isCanonicalArtifacts({ specs: [{ title: "t", specId: "s" }] })).toBe(false);
  });
});

describe("majorVersion", () => {
  it("reads the major of a semver string", () => {
    expect(majorVersion("1.2.0")).toBe(1);
    expect(majorVersion("2.0.0")).toBe(2);
  });
});

// ── The cross-check against the committed graph ─────────────────────

const FACTS: GoldenGraphFacts = {
  graphId: "coding",
  graphVersion: "1.2.0",
  nodeIds: new Set(["research_body", "research_reflect", "research_collect"]),
  effectNames: new Set(["research.reflect"]),
};

function caseFor(mutate: (draft: Record<string, unknown>) => void = () => undefined) {
  const parsed = parseGoldenCase(mutated(mutate), "fixture-case.json");
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.errors.join("; ")}`);
  return parsed.goldenCase;
}

describe("checkCaseAgainstGraph", () => {
  it("reports nothing for a case that matches the graph", () => {
    expect(checkCaseAgainstGraph(caseFor(), FACTS)).toEqual([]);
  });

  it("rejects a case recorded against a different graph", () => {
    const violations = checkCaseAgainstGraph(
      caseFor((d) => ((d.graph as Record<string, unknown>).graphId = "planning")),
      FACTS,
    );
    expect(violations.some((v) => v.includes("graph.graphId"))).toBe(true);
  });

  it("rejects a case recorded against a different MAJOR version", () => {
    const violations = checkCaseAgainstGraph(
      caseFor((d) => ((d.graph as Record<string, unknown>).graphVersion = "2.0.0")),
      FACTS,
    );
    expect(violations.some((v) => v.includes("re-pinned"))).toBe(true);
  });

  it("tolerates a minor version difference, so a minor bump does not churn the dataset", () => {
    const violations = checkCaseAgainstGraph(
      caseFor((d) => ((d.graph as Record<string, unknown>).graphVersion = "1.0.0")),
      FACTS,
    );
    expect(violations).toEqual([]);
  });

  it("rejects an entry node the graph does not have", () => {
    const violations = checkCaseAgainstGraph(
      caseFor((d) => ((d.input as Record<string, unknown>).entryNodeId = "no_such_node")),
      FACTS,
    );
    expect(violations.some((v) => v.includes("entryNodeId"))).toBe(true);
  });

  it("rejects a terminal node the graph does not have", () => {
    const violations = checkCaseAgainstGraph(
      caseFor((d) => ((d.expected as Record<string, unknown>).terminalNodeId = "no_such_node")),
      FACTS,
    );
    expect(violations.some((v) => v.includes("terminalNodeId"))).toBe(true);
  });

  it("rejects a pinned response on a node the graph does not have", () => {
    const violations = checkCaseAgainstGraph(
      caseFor((d) => {
        const pinned = d.pinnedResponses as Record<string, unknown>[];
        pinned[0].nodeId = "renamed_node";
      }),
      FACTS,
    );
    expect(violations.some((v) => v.includes("no such node"))).toBe(true);
  });

  it("rejects a pinned response for an effect the registry does not have", () => {
    const violations = checkCaseAgainstGraph(
      caseFor((d) => {
        const pinned = d.pinnedResponses as Record<string, unknown>[];
        pinned[0].effectName = "research.imagine";
      }),
      FACTS,
    );
    expect(violations.some((v) => v.includes("no such effect"))).toBe(true);
  });
});
