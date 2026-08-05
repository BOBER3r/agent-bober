import { describe, expect, it } from "vitest";
import {
  CHECKSUM_PATTERN,
  GRAPH_VERSION_PATTERN,
  TopologySpecSchema,
} from "../../contracts/topology.js";
import type { EdgeSpec, NodeSpec, TopologySpec } from "../../contracts/topology.js";
import { canonicalize, checksumTopology } from "./canonical.js";
import {
  AUTHORED_GRAPHS,
  CODING_GRAPH,
  CODING_GRAPH_ID,
  CODING_SCHEMA_REFS,
  authoredGraph,
} from "./coding.graph.js";
import { findCycles, validateTopology } from "./validate.js";

/**
 * The authored coding topology.
 *
 * Node ids are PINNED, region by region, against the architecture's mermaid
 * blueprint. The assertion is set equality rather than containment, so a silently
 * dropped node fails AND a silently added one fails.
 */

// ── Pinned blueprint node ids ───────────────────────────────────────

const RESEARCH_REGION = [
  "research_body",
  "gate_research_in",
  "research_reflect",
  "research_explore",
  "research_critique",
  "research_route",
  "research_collect",
  "gate_research_out",
] as const;

const PLAN_REGION = [
  "gate_plan_in",
  "plan_draft",
  "plan_clarify_check",
  "plan_clarify",
  "plan_materialize",
  "gate_plan_out",
] as const;

const SPRINT_REGION = [
  "fanout_sprints",
  "sprint_body",
  "gate_sprint_in",
  "sprint_curate_explain",
  "sprint_curate_mocks",
  "gate_mock_coverage",
  "sprint_generate",
  "gate_syntax",
  "sprint_security",
  "sprint_evaluate",
  "gate_anchor_regression",
  "sprint_route",
  "sprint_correct",
  "sprint_review",
  "sprint_exit",
  "reduce_sprints",
  "gate_sprint_out",
] as const;

const EVALUATION_REGION = [
  "gate_eval_in",
  "evaluate_global",
  "route_after_eval",
  "critique",
  "rework_route",
  "synthesize",
  "documenter",
] as const;

const TERMINAL_REGION = ["hitl_commit", "commit", "finalize", "graceful_failure"] as const;

const CONTEXT_COMPACTION_REGION = ["supervisor", "context_compact"] as const;

const BLUEPRINT_NODE_IDS: readonly string[] = [
  ...RESEARCH_REGION,
  ...PLAN_REGION,
  ...SPRINT_REGION,
  ...EVALUATION_REGION,
  ...TERMINAL_REGION,
  ...CONTEXT_COMPACTION_REGION,
];

const nodeById = new Map<string, NodeSpec>(CODING_GRAPH.nodes.map((n) => [n.id, n]));

function nodeOrThrow(id: string): NodeSpec {
  const node = nodeById.get(id);
  if (!node) throw new Error(`CODING_GRAPH has no node "${id}"`);
  return node;
}

/** A structural clone, so a mutation test cannot leak into the shared literal. */
function clone(spec: TopologySpec): TopologySpec {
  return TopologySpecSchema.parse(JSON.parse(JSON.stringify(spec)) as unknown);
}

// ── sc-2-1 ──────────────────────────────────────────────────────────

describe("CODING_GRAPH parses and validates", () => {
  it("parses through TopologySpecSchema without a single issue", () => {
    const parsed = TopologySpecSchema.safeParse(CODING_GRAPH);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.graphId).toBe("coding");
    expect(parsed.data.formatVersion).toBe(1);
    expect(parsed.data.provenance).toBe("authored");
    expect(parsed.data.graphVersion).toMatch(GRAPH_VERSION_PATTERN);
    // Bumped from 1.0.0 when the bypassing retry cycles gained explicit loop bounds.
    expect(parsed.data.graphVersion).toBe("1.1.0");
  });

  it("returns ok:true with zero diagnostics in structural mode", () => {
    const report = validateTopology(CODING_GRAPH);
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.spec?.graphId).toBe(CODING_GRAPH_ID);
  });

  it("has zero error-severity diagnostics", () => {
    const report = validateTopology(CODING_GRAPH);
    expect(report.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("survives a JSON round trip byte for byte in canonical form", () => {
    const roundTripped = TopologySpecSchema.parse(
      JSON.parse(JSON.stringify(CODING_GRAPH)) as unknown,
    );
    expect(canonicalize(roundTripped)).toBe(canonicalize(CODING_GRAPH));
    expect(checksumTopology(roundTripped)).toBe(CODING_GRAPH.checksum);
  });
});

// ── sc-2-2 ──────────────────────────────────────────────────────────

describe("blueprint node coverage", () => {
  it("declares exactly the pinned blueprint node ids", () => {
    expect([...CODING_GRAPH.nodes.map((n) => n.id)].sort()).toEqual([...BLUEPRINT_NODE_IDS].sort());
  });

  it("declares 44 nodes with unique ids", () => {
    expect(CODING_GRAPH.nodes).toHaveLength(44);
    expect(BLUEPRINT_NODE_IDS).toHaveLength(44);
    expect(new Set(CODING_GRAPH.nodes.map((n) => n.id)).size).toBe(44);
  });

  it.each([
    { region: "research", ids: RESEARCH_REGION },
    { region: "plan", ids: PLAN_REGION },
    { region: "sprint", ids: SPRINT_REGION },
    { region: "evaluation", ids: EVALUATION_REGION },
    { region: "terminal", ids: TERMINAL_REGION },
    { region: "context-compaction", ids: CONTEXT_COMPACTION_REGION },
  ])("keeps every $region node", ({ ids }) => {
    for (const id of ids) {
      expect(nodeById.has(id), `missing blueprint node "${id}"`).toBe(true);
    }
  });

  it("declares unique edge ids and no dangling endpoint", () => {
    const ids = CODING_GRAPH.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const edge of CODING_GRAPH.edges) {
      expect(nodeById.has(edge.from), `edge ${edge.id} from`).toBe(true);
      expect(edge.to === "END" || nodeById.has(edge.to), `edge ${edge.id} to`).toBe(true);
    }
  });

  it("pins the kind of every node the blueprint gives a shape", () => {
    const expected: Record<string, NodeSpec["kind"]> = {
      research_body: "subgraph",
      sprint_body: "subgraph",
      supervisor: "router",
      research_route: "router",
      plan_clarify_check: "router",
      fanout_sprints: "router",
      sprint_route: "router",
      route_after_eval: "router",
      rework_route: "router",
      gate_research_in: "gate",
      gate_research_out: "gate",
      gate_plan_in: "gate",
      gate_plan_out: "gate",
      gate_sprint_in: "gate",
      gate_sprint_out: "gate",
      gate_eval_in: "gate",
      gate_syntax: "gate",
      gate_mock_coverage: "gate",
      gate_anchor_regression: "gate",
      reduce_sprints: "gate",
      plan_clarify: "gate",
      hitl_commit: "gate",
      plan_draft: "llm",
      sprint_generate: "llm",
      evaluate_global: "llm",
      documenter: "llm",
      commit: "tool",
      finalize: "tool",
      graceful_failure: "tool",
      context_compact: "tool",
    };
    for (const [id, kind] of Object.entries(expected)) {
      expect(nodeOrThrow(id).kind, `node ${id}`).toBe(kind);
    }
  });

  it("declares the research and sprint subgraphs and nothing deeper", () => {
    expect(CODING_GRAPH.subgraphs.map((s) => s.id).sort()).toEqual(["research", "sprint"]);
    for (const sub of CODING_GRAPH.subgraphs) {
      expect(sub.persistence).toBe("inherit");
      expect(sub.depth).toBe(1);
      expect(nodeById.has(sub.entryGate)).toBe(true);
      expect(nodeOrThrow(sub.entryGate).kind).toBe("gate");
      expect(nodeOrThrow(sub.exitGate).kind).toBe("gate");
    }
  });
});

// ── Structural invariants the validator enforces ────────────────────

describe("structural invariants", () => {
  it("bounds every cycle with a declared loop", () => {
    const cycles = findCycles(CODING_GRAPH);
    expect(cycles.length).toBeGreaterThan(0);
    for (const cycle of cycles) {
      const bounded = cycle.nodeIds
        .map((id) => nodeById.get(id))
        .filter((n) => n?.loop !== undefined);
      expect(bounded.length, `cycle [${cycle.nodeIds.join(",")}] is unbounded`).toBeGreaterThan(0);
    }
  });

  /**
   * The retry routes declared through `gate.onFail` re-enter an earlier node WITHOUT
   * passing through their region's router, so `supervisorRounds` / `sprintIterations`
   * spent by that router do not bound them. Each therefore carries its own bound. This
   * is the encoded decision for `reduce_sprints`: the global supervisor budget does NOT
   * cover it, because its retry edge never reaches the supervisor.
   */
  it.each([
    { id: "reduce_sprints", onFail: "fanout_sprints", counterKey: "fanoutRetries" },
    { id: "gate_mock_coverage", onFail: "sprint_curate_mocks", counterKey: "mockCurationRounds" },
  ])("bounds the $id retry route that bypasses the supervisor", ({ id, onFail, counterKey }) => {
    const node = nodeOrThrow(id);
    expect(node.kind).toBe("gate");
    if (node.kind !== "gate") return;
    expect(node.gate.onFail).toBe(onFail);
    expect(node.loop?.counterKey).toBe(counterKey);
    expect(node.loop?.maxIterations).toBeGreaterThanOrEqual(1);
    const target = node.loop?.onExhausted ?? "";
    expect(target === "END" || nodeById.has(target)).toBe(true);
    // The retry increments a counter, so it must declare the channel it writes.
    expect(node.writes).toContain("counters");
  });

  it("counts every route into sprint_correct against the branch's own iteration budget", () => {
    const corrector = nodeOrThrow("sprint_correct");
    const router = nodeOrThrow("sprint_route");
    // Same counter as the router: three correction attempts per branch in total,
    // whether the router or a gate's onFail sent the branch back.
    expect(corrector.loop?.counterKey).toBe(router.loop?.counterKey);
    expect(corrector.loop?.maxIterations).toBe(router.loop?.maxIterations);
    expect(corrector.writes).toContain("counters");
    // The gates that reach it directly, bypassing the router.
    for (const gateId of ["gate_syntax", "gate_anchor_regression"]) {
      const gate = nodeOrThrow(gateId);
      expect(gate.kind).toBe("gate");
      if (gate.kind !== "gate") continue;
      expect(gate.gate.onFail).toBe("sprint_correct");
    }
  });

  it.each(["research_route", "sprint_route", "rework_route"])(
    "declares counterKey, maxIterations and onExhausted on the loop-bearing router %s",
    (id) => {
      const node = nodeOrThrow(id);
      expect(node.kind).toBe("router");
      expect(node.loop).toBeDefined();
      expect(node.loop?.counterKey.length).toBeGreaterThan(0);
      expect(node.loop?.maxIterations).toBeGreaterThanOrEqual(1);
      expect(node.loop?.onExhausted.length).toBeGreaterThan(0);
      const target = node.loop?.onExhausted ?? "";
      expect(target === "END" || nodeById.has(target)).toBe(true);
    },
  );

  it("passes every subgraph-boundary edge through a gate node", () => {
    const crossings = CODING_GRAPH.edges.filter((e) => {
      const from = nodeById.get(e.from);
      const to = nodeById.get(e.to);
      return from !== undefined && to !== undefined && from.subgraph !== to.subgraph;
    });
    expect(crossings.length).toBeGreaterThan(0);
    for (const edge of crossings) {
      const kinds = [nodeOrThrow(edge.from).kind, nodeOrThrow(edge.to).kind];
      expect(kinds, `edge ${edge.id} crosses a boundary ungated`).toContain("gate");
    }
  });

  it("returns every declared subgraph exit edge to the supervisor, directly or through a root barrier", () => {
    const supervisor = CODING_GRAPH.defaults.supervisorNodeId;
    const exitGates = new Set(CODING_GRAPH.subgraphs.map((s) => s.exitGate));
    const exitEdges = CODING_GRAPH.edges.filter((e) => exitGates.has(e.from));
    expect(exitEdges.length).toBe(2);
    for (const edge of exitEdges) {
      if (edge.to === supervisor) continue;
      // The only permitted alternative is a ROOT-level fan-in barrier gate whose every
      // edge routes to the supervisor, so control still returns to the supervisor.
      const barrier = nodeOrThrow(edge.to);
      expect(barrier.kind, `${edge.id} must reach the supervisor or a barrier gate`).toBe("gate");
      expect(barrier.subgraph).toBeNull();
      const onward = CODING_GRAPH.edges.filter((e) => e.from === barrier.id);
      expect(onward.length).toBeGreaterThan(0);
      for (const next of onward) expect(next.to).toBe(supervisor);
    }
  });

  /**
   * Regression: sprint-2 review, blocking finding 2.
   *
   * `reduce_sprints` had been authored with `subgraph: "sprint"` and wired
   * `sprint_exit -> reduce_sprints -> gate_sprint_out -> supervisor`, inverting the
   * blueprint. A barrier declared inside the fanned-out subgraph is instantiated once
   * per dispatched branch, so it joins nothing and each branch drives its own return to
   * the supervisor — N returns per fan-out instead of one.
   *
   * Subgraph MEMBERSHIP is what these assertions pin, not membership of the validator's
   * reachability-derived fan-out region: every node downstream of a `fanout` edge is in
   * that region, including a correctly-placed root barrier, so the region cannot tell a
   * join apart from a per-branch node.
   */
  describe("the sprint fan-in barrier", () => {
    it("is declared at the root, not inside the fanned-out sprint subgraph", () => {
      const barrier = nodeOrThrow("reduce_sprints");
      expect(barrier.kind).toBe("gate");
      expect(barrier.subgraph).toBeNull();
    });

    it("sits AFTER the sprint exit gate, in the blueprint's order", () => {
      const edgeBetween = (from: string, to: string): EdgeSpec | undefined =>
        CODING_GRAPH.edges.find((e) => e.from === from && e.to === to);
      expect(edgeBetween("sprint_exit", "gate_sprint_out")).toBeDefined();
      expect(edgeBetween("gate_sprint_out", "reduce_sprints")).toBeDefined();
      expect(edgeBetween("reduce_sprints", "supervisor")).toBeDefined();
      // ...and NOT the inverted order the review caught.
      expect(edgeBetween("sprint_exit", "reduce_sprints")).toBeUndefined();
      expect(edgeBetween("reduce_sprints", "gate_sprint_out")).toBeUndefined();
      expect(edgeBetween("gate_sprint_out", "supervisor")).toBeUndefined();
    });

    it("is the sole edge returning the sprint fan-out to the supervisor", () => {
      const supervisor = CODING_GRAPH.defaults.supervisorNodeId;
      const fromSprintRegion = CODING_GRAPH.edges.filter(
        (e) => e.to === supervisor && nodeById.get(e.from)?.subgraph === "sprint",
      );
      expect(fromSprintRegion).toEqual([]);
      const barrierReturns = CODING_GRAPH.edges.filter(
        (e) => e.from === "reduce_sprints" && e.to === supervisor,
      );
      expect(barrierReturns.length).toBe(1);
    });

    it("retries a failed branch by re-entering the fan-out", () => {
      expect(nodeOrThrow("reduce_sprints").gate?.onFail).toBe("fanout_sprints");
    });
  });

  it("fans out only into the single sprint subgraph call site", () => {
    const fanouts = CODING_GRAPH.edges.filter((e) => e.kind === "fanout");
    expect(fanouts.map((e) => e.from).sort()).toEqual(["fanout_sprints", "rework_route"]);
    for (const edge of fanouts) {
      expect(edge.to).toBe("sprint_body");
    }
    expect(nodeOrThrow("sprint_body").kind).toBe("subgraph");
  });

  it("keeps a cache policy only on effect-free nodes", () => {
    const cached = CODING_GRAPH.nodes.filter((n) => n.cache !== undefined);
    expect(cached.map((n) => n.id).sort()).toEqual(["research_critique", "sprint_curate_explain"]);
    for (const node of cached) {
      expect(node.effects).toEqual([]);
    }
  });

  it("keeps the git effect behind a human-in-the-loop approval node", () => {
    const gitNodes = CODING_GRAPH.nodes.filter((n) => n.effects.includes("git"));
    expect(gitNodes.map((n) => n.id)).toEqual(["commit"]);
    const approvals = CODING_GRAPH.edges.filter((e) => e.to === "commit").map((e) => e.from);
    expect(approvals).toEqual(["hitl_commit"]);
    expect(nodeOrThrow("hitl_commit").hitl?.checkpointId).toBe("hitl-commit");
    expect(nodeOrThrow("hitl_commit").effects).toEqual([]);
  });

  it("gives every human-in-the-loop node an onReject endpoint and no effects", () => {
    const hitl = CODING_GRAPH.nodes.filter((n) => n.hitl !== undefined);
    expect(hitl.map((n) => n.id).sort()).toEqual(["hitl_commit", "plan_clarify"]);
    for (const node of hitl) {
      expect(node.hitl?.onReject).toBe("graceful_failure");
      expect(node.effects).toEqual([]);
    }
  });

  it("gives every llm node a promptRef and no tool node one", () => {
    for (const node of CODING_GRAPH.nodes) {
      if (node.kind === "llm") {
        expect(typeof node.promptRef, `llm node ${node.id}`).toBe("string");
        expect(node.modelTier === "light" || node.modelTier === "frontier").toBe(true);
      }
      if (node.kind === "tool") {
        expect(node.promptRef, `tool node ${node.id}`).toBeUndefined();
        expect(node.toolRef.length).toBeGreaterThan(0);
      }
    }
    const promptRefs = CODING_GRAPH.nodes
      .map((n) => n.promptRef)
      .filter((r): r is string => r !== undefined);
    expect(new Set(promptRefs).size).toBe(promptRefs.length);
    expect(promptRefs).toContain("planner/draft");
    expect(promptRefs).toContain("generator/sprint");
  });

  it("documents every node", () => {
    for (const node of CODING_GRAPH.nodes) {
      expect(typeof node.doc, `node ${node.id}`).toBe("string");
      expect((node.doc ?? "").trim().length, `node ${node.id}`).toBeGreaterThan(20);
    }
  });

  it("declares every channel a node reads or writes, and one writer per scalar channel", () => {
    const declared = new Set(CODING_GRAPH.channels.map((c) => c.id));
    const writersByChannel = new Map<string, string[]>();
    for (const node of CODING_GRAPH.nodes) {
      for (const ref of [...node.reads, ...node.writes]) {
        expect(declared.has(ref), `node ${node.id} names undeclared channel "${ref}"`).toBe(true);
      }
      for (const ref of node.writes) {
        writersByChannel.set(ref, [...(writersByChannel.get(ref) ?? []), node.id]);
      }
    }
    // `replaceIfNewer` is the only scalar reducer; a second writer would be a
    // MultipleWritersOnScalarChannel error.
    for (const channel of CODING_GRAPH.channels) {
      if (channel.reducerRef !== "replaceIfNewer") continue;
      expect(writersByChannel.get(channel.id), `scalar channel ${channel.id}`).toHaveLength(1);
    }
    expect(writersByChannel.get("spec")).toEqual(["plan_materialize"]);
    expect(writersByChannel.get("verdict")).toEqual(["finalize"]);
  });

  it("resolves every schemaRef it names through CODING_SCHEMA_REFS", () => {
    const known = new Set(CODING_SCHEMA_REFS);
    for (const channel of CODING_GRAPH.channels) {
      expect(known.has(channel.schemaRef), `channel ${channel.id}`).toBe(true);
    }
    for (const node of CODING_GRAPH.nodes) {
      for (const port of [...node.inputPorts, ...node.outputPorts]) {
        expect(known.has(port.schemaRef), `${node.id}.${port.key}`).toBe(true);
      }
    }
    // The fixture refs the CLI's full-mode catalog must also resolve.
    for (const ref of ["GraphMessage", "Counters", "PlanSpec", "BranchStatus", "FeatureRequest"]) {
      expect(known.has(ref)).toBe(true);
    }
    expect(known.has("NoSuchSchema")).toBe(false);
  });

  it("binds only declared port keys on port-bound edges", () => {
    const bound = CODING_GRAPH.edges.filter((e) => e.ports !== undefined);
    expect(bound.length).toBeGreaterThan(8);
    for (const edge of bound) {
      const from = nodeOrThrow(edge.from);
      const to = nodeOrThrow(edge.to);
      const output = from.outputPorts.find((p) => p.key === edge.ports?.from);
      const input = to.inputPorts.find((p) => p.key === edge.ports?.to);
      expect(output, `edge ${edge.id} output port`).toBeDefined();
      expect(input, `edge ${edge.id} input port`).toBeDefined();
      expect(output?.schemaRef, `edge ${edge.id} schema`).toBe(input?.schemaRef);
    }
  });

  it("declares every labelled edge's label on its source router", () => {
    for (const edge of CODING_GRAPH.edges) {
      if (edge.label === undefined) continue;
      const source = nodeOrThrow(edge.from);
      expect(source.kind, `edge ${edge.id}`).toBe("router");
      if (source.kind !== "router") continue;
      const target = source.targets.find((t) => t.label === edge.label);
      expect(target, `router ${source.id} does not declare "${edge.label}"`).toBeDefined();
      expect(target?.to).toBe(edge.to);
    }
  });
});

// ── sc-2-9 (literal half) ───────────────────────────────────────────

describe("checksum sealing", () => {
  it("carries the checksum of its own canonical form", () => {
    expect(CODING_GRAPH.checksum).toMatch(CHECKSUM_PATTERN);
    expect(CODING_GRAPH.checksum).toBe(checksumTopology(CODING_GRAPH));
  });

  it("is not the unsealed placeholder", () => {
    expect(CODING_GRAPH.checksum).not.toBe(`sha256:${"0".repeat(64)}`);
  });

  it("surfaces a tampered checksum as ChecksumStale rather than passing", () => {
    const tampered = clone(CODING_GRAPH);
    tampered.checksum = `sha256:${"c".repeat(64)}`;
    const report = validateTopology(tampered);
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((d) => d.code)).toEqual(["ChecksumStale"]);
    expect(report.diagnostics[0].path).toEqual(["checksum"]);
  });
});

// ── sc-2-7 (structure-only checksum) ────────────────────────────────

describe("the checksum tracks structure, not content", () => {
  it("changes when one edge is added", () => {
    const mutated = clone(CODING_GRAPH);
    mutated.edges.push({
      id: "e-extra",
      from: "context_compact",
      to: "graceful_failure",
      kind: "normal",
    });
    expect(checksumTopology(mutated)).not.toBe(CODING_GRAPH.checksum);
  });

  it("changes when one edge is removed", () => {
    const mutated = clone(CODING_GRAPH);
    mutated.edges = mutated.edges.filter((e: EdgeSpec) => e.id !== "e-eval-partial");
    expect(checksumTopology(mutated)).not.toBe(CODING_GRAPH.checksum);
  });

  it("changes when one router outcome label is added", () => {
    const mutated = clone(CODING_GRAPH);
    const router = mutated.nodes.find((n) => n.id === "route_after_eval");
    if (router?.kind !== "router") throw new Error("route_after_eval is not a router");
    router.targets.push({ label: "abort", to: "graceful_failure" });
    expect(checksumTopology(mutated)).not.toBe(CODING_GRAPH.checksum);
  });

  it("does not change when node, edge or channel declaration order changes", () => {
    const shuffled = clone(CODING_GRAPH);
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    shuffled.channels.reverse();
    expect(checksumTopology(shuffled)).toBe(CODING_GRAPH.checksum);
  });

  it("does not change when a promptRef's body changes, because bodies are not in the artifact", () => {
    // The artifact stores the REF, never the prompt text: there is no field a prompt
    // body could occupy, so the checksum is structurally unable to observe one.
    const serialized = JSON.stringify(CODING_GRAPH);
    expect(serialized).toContain('"planner/draft"');
    expect(serialized).not.toContain("You are the planner");
    expect(checksumTopology(CODING_GRAPH)).toBe(CODING_GRAPH.checksum);
  });

  it("does not change when the graph is re-derived from its own JSON", () => {
    const reparsed = TopologySpecSchema.parse(JSON.parse(JSON.stringify(CODING_GRAPH)) as unknown);
    expect(checksumTopology(reparsed)).toBe(CODING_GRAPH.checksum);
  });
});

// ── Authored graph registry ─────────────────────────────────────────

describe("authoredGraph", () => {
  it("resolves the coding graph", () => {
    expect(authoredGraph("coding")).toBe(CODING_GRAPH);
    expect(CODING_GRAPH_ID).toBe("coding");
    expect(Object.keys(AUTHORED_GRAPHS)).toEqual(["coding"]);
  });

  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "nope"])(
    "returns undefined for %s",
    (id) => {
      expect(authoredGraph(id)).toBeUndefined();
    },
  );

  it("ships no optimizer-provenance graph", () => {
    for (const spec of Object.values(AUTHORED_GRAPHS)) {
      expect(spec.provenance).toBe("authored");
    }
  });
});
